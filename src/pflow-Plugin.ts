import {
    debounce,
    type Editor,
    type MarkdownFileInfo,
    type MarkdownView,
    Notice,
    Plugin,
} from "obsidian";
import type {
    ConnectionConfig,
    IOllamaClient,
    Logger,
    PromptFlowSettings,
    ResolvedPrompt,
} from "./@types";
import { DEFAULT_SETTINGS } from "./pflow-Constants";
import { ContentGenerator } from "./pflow-ContentGenerator";
import { createLLMClient } from "./pflow-LLMClientFactory";
import { PromptFlowSettingsTab } from "./pflow-SettingsTab";
import { compileExcludePatterns } from "./pflow-Utils";

export class PromptFlowPlugin extends Plugin implements Logger {
    settings!: PromptFlowSettings;
    generator!: ContentGenerator;

    private commandIds: string[] = [];
    private excludePatterns: RegExp[] = [];

    promptFlow() {
        // window is intentional: filters are shared globally
        return window.promptFlow;
    }

    async onload() {
        await this.loadSettings();

        this.addSettingTab(new PromptFlowSettingsTab(this.app, this));
        this.generator = new ContentGenerator(this.app, this.settings, this);

        this.addCommand({
            id: "verify-prompt-file",
            name: "Verify prompt file",
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (!file) {
                    new Notice("No active file.");
                    return;
                }
                const errors =
                    await this.generator.promptResolver.validatePromptFile(
                        file.path,
                    );
                if (errors.length === 0) {
                    new Notice(`✓ Valid prompt file: ${file.name}`);
                } else {
                    new Notice(
                        `✗ Prompt file errors:\n${errors.join("\n")}`,
                        8000,
                    );
                }
            },
        });

        // window is intentional: filters are shared globally
        window.promptFlow = window.promptFlow ?? {};
        window.promptFlow.filters = window.promptFlow.filters ?? {};

        // Defer initialization until layout is ready
        this.app.workspace.onLayoutReady(() => {
            this.generateCommands();
        });
        this.logInfo("Loaded Prompt Flow (PF)", `v${this.manifest.version}`);
    }

    onunload() {
        this.logInfo("Unloaded Prompt Flow (PF)");
    }

    onExternalSettingsChange = debounce(
        async () => {
            const incoming = (await this.loadData()) as PromptFlowSettings;
            this.logDebug("Settings changed", incoming);
            this.settings = Object.assign({}, this.settings, incoming);
            this.refreshDerivedState();
        },
        2000,
        true,
    );

    getConnectionConfig(resolvedPrompt: ResolvedPrompt): {
        connectionKey: string;
        connection: ConnectionConfig;
    } {
        const connectionKey =
            resolvedPrompt.connection || this.settings.defaultConnection;
        return {
            connectionKey,
            connection: this.settings.connections[connectionKey],
        };
    }

    getClientForPrompt(resolvedPrompt: ResolvedPrompt): IOllamaClient {
        const connectionKey =
            resolvedPrompt.connection || this.settings.defaultConnection;
        const connection = this.settings.connections[connectionKey];

        if (!connection) {
            throw new Error(
                `Connection '${connectionKey}' not found in settings`,
            );
        }

        return createLLMClient(connection, this.app, this, () =>
            this.saveSettings(),
        );
    }

    private clearCommands() {
        for (const commandId of this.commandIds) {
            this.removeCommand(commandId);
        }
        this.commandIds = [];
    }

    private generateCommands() {
        this.clearCommands();

        for (const [promptKey, promptConfig] of Object.entries(
            this.settings.prompts,
        )) {
            const commandId = promptConfig.displayLabel
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "");

            this.addCommand({
                id: commandId,
                name: `${promptConfig.displayLabel}`,
                editorCallback: async (
                    editor: Editor,
                    ctx: MarkdownView | MarkdownFileInfo,
                ) => {
                    await this.generator.generateContentWithEditor(
                        editor,
                        ctx,
                        promptKey,
                    );
                },
                callback: async () => {
                    await this.generator.generateContent(promptKey);
                },
            });

            this.commandIds.push(commandId);
        }
    }

    async loadSettings() {
        const loaded = (await this.loadData()) as PromptFlowSettings & {
            ollamaUrl?: string;
            modelName?: string;
            keepAlive?: string;
            systemPrompt?: string;
            affirmationPromptFile?: string;
            reflectionPromptFile?: string;
            excludeLinkPatterns?: string;
        };

        let migrated = false;
        // Migrate old settings format to new connections format
        if (
            loaded?.ollamaUrl ||
            loaded?.modelName ||
            loaded?.keepAlive ||
            loaded?.systemPrompt ||
            loaded?.affirmationPromptFile ||
            loaded?.reflectionPromptFile ||
            loaded?.excludeLinkPatterns
        ) {
            migrated = true;
            this.logInfo(
                "Migrating old settings format to new connections format",
            );

            if (loaded?.ollamaUrl && !loaded.connections) {
                loaded.connections = {
                    "local-ollama": {
                        provider: "ollama",
                        baseUrl: loaded.ollamaUrl,
                        defaultModel: loaded.modelName || "llama3.1",
                        keepAlive: loaded.keepAlive || "10m",
                    },
                };
                loaded.defaultConnection = "local-ollama";
            }

            if (loaded.excludeLinkPatterns) {
                loaded.excludePatterns =
                    loaded.excludePatterns || loaded.excludeLinkPatterns;
            }

            // Clean up old fields
            delete loaded.ollamaUrl;
            delete loaded.modelName;
            delete loaded.keepAlive;
            delete loaded.systemPrompt;
            delete loaded.affirmationPromptFile;
            delete loaded.reflectionPromptFile;
            delete loaded.excludeLinkPatterns;
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
        if (migrated) {
            await this.saveSettings();
        } else {
            this.refreshDerivedState();
        }
    }

    async saveSettings() {
        this.logDebug("Saving settings", this.settings);
        await this.saveData(this.settings);
        this.refreshDerivedState();
    }

    refreshDerivedState() {
        this.excludePatterns = compileExcludePatterns(
            this.settings.excludePatterns,
        );
        this.generateCommands();
    }

    shouldExcludeLink(
        linkCache: {
            link: string;
            displayText?: string;
        },
        additionalPatterns: RegExp[] = [],
    ): boolean {
        // Check global exclude patterns (match against display text format)
        const textToCheck = `[${linkCache.displayText}](${linkCache.link})`;
        const allPatterns = [
            ...this.excludePatterns,
            ...additionalPatterns,
        ].filter(Boolean);

        return allPatterns.some((pattern) => pattern.test(textToCheck));
    }

    logInfo(message: string, ...params: unknown[]): void {
        // eslint-disable-next-line obsidianmd/rule-custom-message
        console.log("(PF)", message, ...params);
    }

    logWarn(message: string, ...params: unknown[]): void {
        console.warn("(PF)", message, ...params);
    }

    logError(
        error: unknown,
        message: string = "",
        ...params: unknown[]
    ): string {
        if (message) {
            console.error("(PF)", message, error, ...params);
            return message;
        } else if (error instanceof Error) {
            console.error("(PF)", error.message, error, ...params);
            return error.message;
        }
        console.error("(PF)", error, ...params);
        return JSON.stringify(error);
    }

    logDebug(message: string, ...params: unknown[]): void {
        if (this.settings?.debugLogging) {
            // eslint-disable-next-line obsidianmd/rule-custom-message
            console.log("(PF)", message, ...params);
        }
    }

    logLlmRequest(payload: unknown): void {
        if (this.settings?.showLlmRequests) {
            // eslint-disable-next-line obsidianmd/rule-custom-message
            console.log("(PF)[LLM Request]", payload);
        }
    }
}
