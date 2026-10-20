import { expect, test } from "bun:test";
import { createJevChoiceClient, DEFAULT_JEV_MODEL } from "../src/jev.js";

test("Jev client is disabled without TypeSafe credentials", () => {
  expect(createJevChoiceClient({})).toBeUndefined();
});

test("Jev client sends typed Choice questions to the System One endpoint", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createJevChoiceClient(
    {
      TYPESAFE_API_KEY: "synthetic-typesafe-key",
      TYPESAFE_BASE_URL: "https://typesafe.example/",
      TYPESAFE_DEFAULT_MODEL: "jev-test",
    },
    undefined,
    async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          model: "jev-test",
          answers: {
            route: {
              type: "choice",
              choice: "review",
              probabilities: { fast: 0.1, review: 0.9 },
              confidence: 0.8,
            },
          },
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  );
  expect(client).toBeDefined();
  const answers = await client!.choose(
    { finding: "example" },
    {
      route: {
        instructions: "Choose the next review path.",
        criteria: {
          fast: "Use the bounded fast path.",
          review: "Escalate to System-2 review.",
        },
      },
    },
  );

  expect(answers["route"]).toEqual({
    choice: "review",
    probabilities: { fast: 0.1, review: 0.9 },
    confidence: 0.8,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("https://typesafe.example/v1/systemone");
  expect(requests[0]!.init?.headers).toMatchObject({
    Authorization: "Bearer synthetic-typesafe-key",
    "Content-Type": "application/json",
  });
  const body = JSON.parse(String(requests[0]!.init?.body));
  expect(body).toEqual({
    state: { finding: "example" },
    model: "jev-test",
    questions: {
      route: {
        type: "choice",
        instructions: "Choose the next review path.",
        criteria: {
          fast: "Use the bounded fast path.",
          review: "Escalate to System-2 review.",
        },
      },
    },
  });
});

async function choiceResponse(
  answer: Record<string, unknown>,
  onRequest?: (body: Record<string, unknown>) => void,
) {
  return createJevChoiceClient(
    { TYPESAFE_API_KEY: "synthetic-typesafe-key" },
    undefined,
    async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      onRequest?.(body);
      return Response.json({
        model: DEFAULT_JEV_MODEL,
        answers: { route: answer },
      });
    },
    { wait: async () => undefined },
  )!;
}

test("Jev retries transient transport and HTTP failures before succeeding", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const client = createJevChoiceClient(
    { TYPESAFE_API_KEY: "synthetic-typesafe-key" },
    undefined,
    async () => {
      attempts++;
      if (attempts === 1) throw new Error("synthetic transport failure");
      if (attempts === 2) return new Response("", { status: 503 });
      return Response.json({
        answers: {
          route: {
            type: "choice",
            choice: "review",
            probabilities: { fast: 0.1, review: 0.9 },
            confidence: 0.8,
          },
        },
      });
    },
    {
      wait: async (delayMs) => {
        delays.push(delayMs);
      },
    },
  )!;

  expect(
    (
      await client.choose("state", {
        route: {
          instructions: "Choose a route.",
          criteria: { fast: "Fast path", review: "System-2" },
        },
      })
    )["route"]?.choice,
  ).toBe("review");
  expect(attempts).toBe(3);
  expect(delays).toEqual([250, 500]);
});

test("Jev retries invalid successful responses but does not retry terminal 4xx", async () => {
  let malformedAttempts = 0;
  const malformedClient = createJevChoiceClient(
    { TYPESAFE_API_KEY: "synthetic-typesafe-key" },
    undefined,
    async () => {
      malformedAttempts++;
      if (malformedAttempts < 3) {
        return Response.json({ answers: { route: { type: "choice" } } });
      }
      return Response.json({
        answers: {
          route: {
            type: "choice",
            choice: "fast",
            probabilities: { fast: 0.75, review: 0.25 },
            confidence: 0.75,
          },
        },
      });
    },
    { wait: async () => undefined },
  )!;
  expect(
    (
      await malformedClient.choose("state", {
        route: {
          instructions: "Choose a route.",
          criteria: { fast: "Fast path", review: "System-2" },
        },
      })
    )["route"]?.choice,
  ).toBe("fast");
  expect(malformedAttempts).toBe(3);

  let terminalAttempts = 0;
  const terminalClient = createJevChoiceClient(
    { TYPESAFE_API_KEY: "synthetic-typesafe-key" },
    undefined,
    async () => {
      terminalAttempts++;
      return new Response("", { status: 401 });
    },
    { wait: async () => undefined },
  )!;
  await expect(
    terminalClient.choose("state", {
      route: {
        instructions: "Choose a route.",
        criteria: { fast: "Fast path", review: "System-2" },
      },
    }),
  ).rejects.toThrow("HTTP 401");
  expect(terminalAttempts).toBe(1);
});

test("Jev client defaults to jev-latest and rejects answers outside the legal action set", async () => {
  let model: unknown;
  const client = await choiceResponse(
    {
      type: "choice",
      choice: "invented",
      probabilities: { fast: 0.5, review: 0.5 },
      confidence: 0,
    },
    (body) => {
      model = body["model"];
    },
  );
  await expect(
    client.choose("state", {
      route: {
        instructions: "Choose a route.",
        criteria: { fast: "Fast path", review: "System-2" },
      },
    }),
  ).rejects.toThrow("invalid Choice answer");
  expect(model).toBe(DEFAULT_JEV_MODEL);
});

test.each([
  [
    "choice contradicts the maximum probability",
    {
      type: "choice",
      choice: "review",
      probabilities: { fast: 0.99, review: 0.01 },
      confidence: 0.9,
    },
  ],
  [
    "probabilities sum to zero",
    {
      type: "choice",
      choice: "fast",
      probabilities: { fast: 0, review: 0 },
      confidence: 0.9,
    },
  ],
  [
    "probabilities sum above one",
    {
      type: "choice",
      choice: "fast",
      probabilities: { fast: 1, review: 1 },
      confidence: 0.9,
    },
  ],
  [
    "probabilities contain an extra label",
    {
      type: "choice",
      choice: "fast",
      probabilities: { fast: 0.5, review: 0.5, other: 0 },
      confidence: 0.9,
    },
  ],
] as const)(
  "rejects inconsistent Choice response: %s",
  async (_name, answer) => {
    const client = await choiceResponse(answer);
    await expect(
      client.choose("state", {
        route: {
          instructions: "Choose a route.",
          criteria: { fast: "Fast path", review: "System-2" },
        },
      }),
    ).rejects.toThrow("Jev returned");
  },
);

test("accepts a tied maximum Choice distribution", async () => {
  const client = await choiceResponse({
    type: "choice",
    choice: "review",
    probabilities: { fast: 0.5, review: 0.5 },
    confidence: 0.5,
  });
  expect(
    (
      await client.choose("state", {
        route: {
          instructions: "Choose a route.",
          criteria: { fast: "Fast path", review: "System-2" },
        },
      })
    )["route"]?.choice,
  ).toBe("review");
});

const cleanupQuestions = {
  route: {
    instructions: "Choose a route.",
    criteria: { fast: "Fast path", review: "System-2" },
  },
};

function streamingResponse(
  status: number,
  onCancel: () => void | Promise<void>,
) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("synthetic error body"));
      },
      cancel: onCancel,
    }),
    { status },
  );
}

test.each([401, 503])(
  "Jev cancels HTTP %i bodies before retry waits or terminal failure",
  async (status) => {
    let attempts = 0;
    let cancellations = 0;
    const client = createJevChoiceClient(
      { TYPESAFE_API_KEY: "synthetic-typesafe-key" },
      undefined,
      async () => {
        attempts++;
        return streamingResponse(status, () => {
          cancellations++;
        });
      },
      {
        wait: async () => {
          expect(cancellations).toBe(attempts);
        },
      },
    )!;
    await expect(client.choose("state", cleanupQuestions)).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(attempts).toBe(status === 401 ? 1 : 3);
    expect(cancellations).toBe(attempts);
  },
);

test("Jev disposes a failed response before retrying successfully", async () => {
  let attempts = 0;
  let cancellations = 0;
  const client = createJevChoiceClient(
    { TYPESAFE_API_KEY: "synthetic-typesafe-key" },
    undefined,
    async () => {
      if (++attempts === 1)
        return streamingResponse(503, () => {
          cancellations++;
        });
      expect(cancellations).toBe(1);
      return Response.json({
        answers: {
          route: {
            type: "choice",
            choice: "fast",
            probabilities: { fast: 1, review: 0 },
            confidence: 1,
          },
        },
      });
    },
    { wait: async () => undefined },
  )!;
  expect(
    (await client.choose("state", cleanupQuestions))["route"]?.choice,
  ).toBe("fast");
  expect(attempts).toBe(2);
  expect(cancellations).toBe(1);
});

test.each([200, 503])(
  "Jev cancels an HTTP %i body received after caller abort",
  async (status) => {
    const controller = new AbortController();
    const reason = new Error("synthetic caller abort");
    let cancellations = 0;
    let waits = 0;
    const client = createJevChoiceClient(
      { TYPESAFE_API_KEY: "synthetic-typesafe-key" },
      controller.signal,
      async () => {
        controller.abort(reason);
        return streamingResponse(status, () => {
          cancellations++;
        });
      },
      {
        wait: async () => {
          waits++;
        },
      },
    )!;
    await expect(client.choose("state", cleanupQuestions)).rejects.toBe(reason);
    expect(cancellations).toBe(1);
    expect(waits).toBe(0);
  },
);

test("Jev preserves HTTP failure when response cleanup rejects", async () => {
  let cancellations = 0;
  const client = createJevChoiceClient(
    { TYPESAFE_API_KEY: "synthetic-typesafe-key" },
    undefined,
    async () =>
      streamingResponse(401, () => {
        cancellations++;
        throw new Error("synthetic cleanup failure");
      }),
  )!;
  await expect(client.choose("state", cleanupQuestions)).rejects.toThrow(
    "HTTP 401",
  );
  expect(cancellations).toBe(1);
});

test.each([
  [401, false],
  [503, false],
  [200, true],
  [503, true],
] as const)(
  "Jev does not wait for stalled HTTP %i cleanup (caller aborted: %p)",
  async (status, abort) => {
    const controller = new AbortController();
    const reason = new Error("synthetic caller abort");
    let cancellations = 0;
    const client = createJevChoiceClient(
      { TYPESAFE_API_KEY: "synthetic-typesafe-key" },
      controller.signal,
      async () => {
        if (abort) controller.abort(reason);
        return streamingResponse(status, () => {
          cancellations++;
          return new Promise<void>(() => {});
        });
      },
      { wait: async () => undefined },
    )!;
    const request = client.choose("state", cleanupQuestions);
    if (abort) await expect(request).rejects.toBe(reason);
    else await expect(request).rejects.toThrow(`HTTP ${status}`);
    expect(cancellations).toBe(status === 503 && !abort ? 3 : 1);
  },
  1_000,
);
