import { environmentEntry } from "./auth.js";
import { CodexSecurityError } from "./errors.js";

export const DEFAULT_JEV_MODEL = "jev-latest";
const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
const JEV_REQUEST_TIMEOUT_MS = 10_000;
const JEV_MAX_ATTEMPTS = 3;
const JEV_RETRY_BASE_DELAY_MS = 250;

export interface JevChoiceQuestion {
  instructions: unknown;
  criteria: Readonly<Record<string, unknown>>;
}

export interface JevChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevChoiceClientMetadata {
  provider: "typesafe-system-one";
  baseURL: string;
  model: string;
}

export interface JevChoiceClient {
  readonly metadata: JevChoiceClientMetadata;
  choose(
    state: unknown,
    questions: Readonly<Record<string, JevChoiceQuestion>>,
  ): Promise<Record<string, JevChoiceAnswer>>;
}

type JevFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

interface JevRetryOptions {
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

const PROBABILITY_EPSILON = 1e-6;

function retryableJevStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function jevRetryDelay(attempt: number): number {
  return JEV_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

async function waitForJevRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  signal?.throwIfAborted();
}

function requiredChoiceAnswer(
  value: unknown,
  labels: ReadonlySet<string>,
): JevChoiceAnswer {
  if (value === null || typeof value !== "object") {
    throw new CodexSecurityError("Jev returned an invalid Choice answer.");
  }
  const answer = value as Record<string, unknown>;
  if (
    answer["type"] !== "choice" ||
    typeof answer["choice"] !== "string" ||
    !labels.has(answer["choice"]) ||
    typeof answer["confidence"] !== "number" ||
    !Number.isFinite(answer["confidence"]) ||
    answer["confidence"] < 0 ||
    answer["confidence"] > 1 ||
    answer["probabilities"] === null ||
    typeof answer["probabilities"] !== "object"
  ) {
    throw new CodexSecurityError("Jev returned an invalid Choice answer.");
  }
  const rawProbabilities = answer["probabilities"] as Record<string, unknown>;
  const probabilityLabels = Object.keys(rawProbabilities);
  if (
    probabilityLabels.length !== labels.size ||
    probabilityLabels.some((label) => !labels.has(label))
  ) {
    throw new CodexSecurityError(
      "Jev returned Choice probabilities for an invalid action set.",
    );
  }
  const probabilities: Record<string, number> = {};
  let total = 0;
  let maximum = -Infinity;
  for (const label of labels) {
    const probability = rawProbabilities[label];
    if (
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      throw new CodexSecurityError(
        "Jev returned invalid Choice probabilities.",
      );
    }
    probabilities[label] = probability;
    total += probability;
    maximum = Math.max(maximum, probability);
  }
  if (Math.abs(total - 1) > PROBABILITY_EPSILON) {
    throw new CodexSecurityError(
      "Jev returned Choice probabilities that do not sum to one.",
    );
  }
  if (probabilities[answer["choice"]]! + PROBABILITY_EPSILON < maximum) {
    throw new CodexSecurityError(
      "Jev returned a Choice that is not a maximum-probability action.",
    );
  }
  return {
    choice: answer["choice"],
    probabilities,
    confidence: answer["confidence"],
  };
}

/**
 * Create the Jev decision client when TypeSafe credentials are available.
 *
 * Jev is an optimization layer in Codex Security. When configured, request
 * failures remain Jev failures after bounded retries; callers only escalate to
 * System-2 when Jev explicitly returns an abstention such as REVIEW.
 *
 * @internal
 */
export function createJevChoiceClient(
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  fetchImpl: JevFetch = globalThis.fetch,
  retryOptions: JevRetryOptions = {},
): JevChoiceClient | undefined {
  const apiKey = environmentEntry(environment, "TYPESAFE_API_KEY")?.trim();
  if (!apiKey) return undefined;
  const baseURL = (
    environmentEntry(environment, "TYPESAFE_BASE_URL")?.trim() ||
    DEFAULT_JEV_BASE_URL
  ).replace(/\/+$/u, "");
  const model =
    environmentEntry(environment, "TYPESAFE_DEFAULT_MODEL")?.trim() ||
    DEFAULT_JEV_MODEL;

  return {
    metadata: {
      provider: "typesafe-system-one",
      baseURL,
      model,
    },
    async choose(state, questions) {
      signal?.throwIfAborted();
      if (Object.keys(questions).length === 0) return {};
      const wait = retryOptions.wait ?? waitForJevRetry;
      const body = JSON.stringify({
        state,
        model,
        questions: Object.fromEntries(
          Object.entries(questions).map(([name, question]) => [
            name,
            {
              type: "choice",
              instructions: question.instructions,
              criteria: question.criteria,
            },
          ]),
        ),
      });
      let lastError: unknown;
      for (let attempt = 1; attempt <= JEV_MAX_ATTEMPTS; attempt++) {
        signal?.throwIfAborted();
        let response: Response;
        const timeoutSignal = AbortSignal.timeout(JEV_REQUEST_TIMEOUT_MS);
        const requestSignal =
          signal === undefined
            ? timeoutSignal
            : AbortSignal.any([signal, timeoutSignal]);
        try {
          response = await fetchImpl(`${baseURL}/v1/systemone`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body,
            signal: requestSignal,
          });
        } catch (error) {
          signal?.throwIfAborted();
          lastError = new CodexSecurityError("Jev decision request failed.", {
            cause: error,
          });
          if (attempt === JEV_MAX_ATTEMPTS) throw lastError;
          await wait(jevRetryDelay(attempt), signal);
          continue;
        }

        signal?.throwIfAborted();
        if (!response.ok) {
          const error = new CodexSecurityError(
            `Jev decision request failed (HTTP ${response.status}).`,
          );
          if (!retryableJevStatus(response.status)) throw error;
          lastError = error;
          if (attempt === JEV_MAX_ATTEMPTS) throw error;
          await wait(jevRetryDelay(attempt), signal);
          continue;
        }

        try {
          const payload = await response.json();
          if (
            payload === null ||
            typeof payload !== "object" ||
            (payload as Record<string, unknown>)["answers"] === null ||
            typeof (payload as Record<string, unknown>)["answers"] !== "object"
          ) {
            throw new CodexSecurityError("Jev returned an invalid response.");
          }
          const rawAnswers = (payload as Record<string, unknown>)[
            "answers"
          ] as Record<string, unknown>;
          const answers: Record<string, JevChoiceAnswer> = {};
          for (const [name, question] of Object.entries(questions)) {
            answers[name] = requiredChoiceAnswer(
              rawAnswers[name],
              new Set(Object.keys(question.criteria)),
            );
          }
          return answers;
        } catch (error) {
          signal?.throwIfAborted();
          lastError =
            error instanceof CodexSecurityError
              ? error
              : new CodexSecurityError("Jev returned invalid JSON.", {
                  cause: error,
                });
          if (attempt === JEV_MAX_ATTEMPTS) throw lastError;
          await wait(jevRetryDelay(attempt), signal);
        }
      }
      throw new CodexSecurityError("Jev decision request failed.", {
        cause: lastError,
      });
    },
  };
}
