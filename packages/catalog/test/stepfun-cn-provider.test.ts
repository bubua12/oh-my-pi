import { describe, expect, test } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { isExcludedModel } from "@oh-my-pi/pi-catalog/compat/behavior";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { stepfunCnModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import modelsJson from "../src/models.json";

const STEP_PLAN_BASE_URL = "https://api.stepfun.com/step_plan/v1";

function withEnv(key: string, value: string | undefined, run: () => void): void {
	const previous = Bun.env[key];
	if (value === undefined) {
		delete Bun.env[key];
	} else {
		Bun.env[key] = value;
	}
	try {
		run();
	} finally {
		if (previous === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = previous;
		}
	}
}

describe("stepfun-cn Step Plan provider", () => {
	test("shows Stepfun (China) in /login and reads the Step Plan key", () => {
		const provider = getOAuthProviders().find(item => item.id === "stepfun-cn");
		expect(provider?.name).toBe("Stepfun (China)");
		expect(provider?.available).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER["stepfun-cn"]).toBe("step-5-preview");
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "stepfun-cn");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(descriptor?.createModelManagerOptions({ apiKey: "k" }).providerId).toBe("stepfun-cn");

		withEnv("STEP_API_KEY", "docs-key", () => {
			withEnv("STEPFUN_CN_API_KEY", undefined, () => {
				expect(getEnvApiKey("stepfun-cn")).toBe("docs-key");
			});
		});
		withEnv("STEP_API_KEY", "docs-key", () => {
			withEnv("STEPFUN_CN_API_KEY", "plan-key", () => {
				expect(getEnvApiKey("stepfun-cn")).toBe("plan-key");
			});
		});
	});

	test("bundles the Step Plan chat roster at the subscription endpoint", () => {
		const models = modelsJson["stepfun-cn"];
		expect(Object.keys(models).sort()).toEqual([
			"step-3.5-flash",
			"step-3.5-flash-2603",
			"step-3.7-flash",
			"step-5-preview",
			"step-router-v1",
		]);

		const preview = models["step-5-preview"];
		expect(preview?.baseUrl).toBe(STEP_PLAN_BASE_URL);
		expect(preview?.api).toBe("openai-completions");
		expect(preview?.contextWindow).toBe(1_000_000);
		expect(preview?.maxTokens).toBe(64_000);
		expect(preview?.input).toEqual(["text", "image"]);
		expect(preview?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(preview?.thinking).toEqual({ mode: "effort", efforts: ["low", "medium", "high"] });
		expect(preview?.compat.maxTokensField).toBe("max_tokens");
		expect(preview?.compat.supportsStore).toBe(false);
		expect(preview?.compat.supportsDeveloperRole).toBe(false);

		const flash = models["step-3.7-flash"];
		expect(flash?.contextWindow).toBe(256_000);
		expect(flash?.maxTokens).toBeNull();
		expect(flash?.input).toEqual(["text", "image"]);

		const text = models["step-3.5-flash"];
		expect(text?.contextWindow).toBe(256_000);
		expect(text?.input).toEqual(["text"]);
		expect(text?.thinking).toEqual({ mode: "effort", efforts: ["low", "medium", "high"] });

		// 2603 publishes only two effort tiers. Sending medium is rejected.
		expect(models["step-3.5-flash-2603"]?.thinking).toEqual({ mode: "effort", efforts: ["low", "high"] });
		expect(models["step-3.5-flash-2603"]?.input).toEqual(["text"]);

		// The router can select the 256K flash engine, so the shared id must not
		// advertise the 1M decision-engine window.
		const router = models["step-router-v1"];
		expect(router?.contextWindow).toBe(256_000);
		expect(router?.maxTokens).toBeNull();
		expect(router?.input).toEqual(["text"]);
	});

	test("live discovery keeps seeded chat windows and drops speech and image generators", async () => {
		expect(isExcludedModel("stepfun-cn", "stepaudio-2.5-tts")).toBe(true);
		expect(isExcludedModel("stepfun-cn", "step-image-edit-2")).toBe(true);
		expect(isExcludedModel("stepfun-cn", "step-5-preview")).toBe(false);

		const seen: string[] = [];
		const stubFetch: FetchImpl = async input => {
			seen.push(String(input));
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{ id: "step-5-preview", object: "model", owned_by: "stepai" },
						{ id: "stepaudio-2.5-realtime", object: "model", owned_by: "stepai" },
						{ id: "step-image-edit-2", object: "model", owned_by: "stepai" },
						{ id: "step-new-chat", object: "model", owned_by: "stepai" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		const discovered = await stepfunCnModelManagerOptions({
			apiKey: "plan-key",
			fetch: stubFetch,
		}).fetchDynamicModels?.();
		expect(seen).toEqual([`${STEP_PLAN_BASE_URL}/models`]);
		const ids = discovered?.map(model => model.id).sort();
		expect(ids).toEqual(["step-5-preview", "step-new-chat"]);
		const preview = discovered?.find(model => model.id === "step-5-preview");
		expect(preview?.contextWindow).toBe(1_000_000);
		expect(preview?.maxTokens).toBe(64_000);
		expect(preview?.input).toEqual(["text", "image"]);
		expect(preview?.baseUrl).toBe(STEP_PLAN_BASE_URL);
		const fresh = discovered?.find(model => model.id === "step-new-chat");
		expect(fresh?.contextWindow).toBeNull();
		expect(fresh?.input).toEqual(["text"]);
	});
});
