import { DialoguePlanningModel } from "../../domain/types";

export class OllamaDialoguePlanningClient implements DialoguePlanningModel {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    console.log("call llm");
    const response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        format: "json",
        stream: false,
        thinking: false,
        think: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(
        `ollama simple pomdp request failed baseUrl=${this.baseUrl} model=${this.model} status=${response.status}`,
      );
    }
    const data = (await response.json()) as { message?: { content?: string } };
    const content = data.message?.content?.trim();
    if (!content) {
      throw new Error("ollama simple pomdp returned empty content");
    }
    return parseJsonResponse<T>(content);
  }
}

export const createOllamaDialoguePlanningModel = (
  baseUrl: string,
  model: string,
  apiKey?: string,
): DialoguePlanningModel =>
  new OllamaDialoguePlanningClient(baseUrl, model, apiKey);

const parseJsonResponse = <T>(raw: string): T => {
  const normalized = unwrapJsonFence(raw.trim());
  try {
    return JSON.parse(normalized) as T;
  } catch {
    return JSON.parse(extractJsonCandidate(normalized)) as T;
  }
};

const unwrapJsonFence = (value: string): string => {
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? value;
};

const extractJsonCandidate = (value: string): string => {
  const objectStart = value.indexOf("{");
  const arrayStart = value.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (starts.length === 0) {
    return value;
  }
  const start = Math.min(...starts);
  const end = Math.max(value.lastIndexOf("}"), value.lastIndexOf("]"));
  if (end < start) {
    return value.slice(start);
  }
  return value.slice(start, end + 1).trim();
};
