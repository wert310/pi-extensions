/**
 * Model Identity Extension
 *
 * Injects the current model's identity into the system prompt.
 * This allows the model to self-identify and apply appropriate attributions.
 *
 * Usage: pi -e ./model-identity.ts
 * Or place in ~/.pi/agent/extensions/ for auto-load
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// Check if extension is enabled (default: true for backward compatibility)
	const isEnabled = () => {
		try {
			const path = require("node:path");
			const fs = require("node:fs");
			const settingsPath = path.join(
				process.env.HOME || process.env.USERPROFILE || "~",
				".pi/agent/settings.json"
			);
			if (fs.existsSync(settingsPath)) {
				const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
				// Explicit false disables, everything else (including undefined) enables
				return settings.extensionSettings?.["model-identity"] !== false;
			}
		} catch {
			// On error, default to enabled for backward compatibility
		}
		return true;
	};

	// Don't register any hooks if disabled
	if (!isEnabled()) {
		return;
	}

	// Track current model info - will be set in before_agent_start
	let currentModel = { provider: "unknown", id: "unknown" };

	// Update model info when model changes
	pi.on("model_select", async (event, _ctx) => {
		const { model } = event;
		currentModel = {
			provider: model.provider,
			id: model.id,
		};
	});

	// Inject model identity into system prompt before each agent turn
	pi.on("before_agent_start", async (_event, ctx) => {
		// Read current model from ctx.model (available in this context)
		// This ensures we always have the correct model even on first startup
		if (ctx.model && ctx.model.provider && ctx.model.id) {
			currentModel = {
				provider: ctx.model.provider,
				id: ctx.model.id,
			};
		}

		// Model identity instruction - minimal and clear
		const modelIdentity = [
			"",
			"## Your Identity",
			`You are running as: **${currentModel.provider}/${currentModel.id}**`,
			"When making git commits, attribute your work using the co-author format.",
			"See the `commit-co-author` skill for attribution guidelines.",
		].join("\n");

		return {
			systemPrompt: ctx.getSystemPrompt() + modelIdentity,
		};
	});
}
