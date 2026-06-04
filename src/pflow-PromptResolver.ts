import { type App, Notice, TFile } from "obsidian";
import type { Logger, PromptFlowSettings, ResolvedPrompt } from "./@types";
import { DEFAULT_PROMPT } from "./pflow-Constants";
import {
    CONTEXT_MODES,
    compileExcludePatterns,
    extractFrontmatterValue,
    normalizeToArray,
    type optionalStrings,
    parseBoolean,
    parseContextMode,
    parseParameterWithConstraint,
    parsePositiveInteger,
} from "./pflow-Utils";

export class PromptResolver {
    constructor(
        private app: App,
        private settings: PromptFlowSettings,
        private logger: Logger,
    ) {}

    resolvePromptFromFile = async (
        file: TFile,
        promptKey: string,
    ): Promise<ResolvedPrompt> => {
        const frontmatter =
            this.app.metadataCache.getFileCache(file)?.frontmatter;

        // Get the prompt configuration from settings
        const promptConfig = this.settings.prompts[promptKey];
        if (!promptConfig) {
            throw new Error(`Unknown prompt key: ${promptKey}`);
        }

        // Find THE prompt file path:
        // 1. Note frontmatter prompt-file (highest priority)
        // 2. Plugin settings promptFile (fallback)
        const promptFilePath =
            extractFrontmatterValue(frontmatter, "prompt-file", promptKey) ||
            promptConfig.promptFile;

        // Read the prompt file if one is specified
        const promptFileData = promptFilePath
            ? await this.readPromptFromFile(promptFilePath)
            : null;

        // Merge: prompt file -> settings -> defaults
        // Precedence: prompt file values override settings, settings override defaults
        return {
            ...promptFileData,
            prompt: promptFileData?.prompt ?? DEFAULT_PROMPT,
            connection: promptFileData?.connection ?? promptConfig.connection,
        };
    };

    readPromptFromFile = async (
        promptFilePath: string,
    ): Promise<ResolvedPrompt | null> => {
        const promptFile = this.app.vault.getAbstractFileByPath(promptFilePath);
        if (promptFile instanceof TFile) {
            try {
                const promptContent =
                    await this.app.vault.cachedRead(promptFile);
                const frontmatter =
                    this.app.metadataCache.getFileCache(
                        promptFile,
                    )?.frontmatter;
                const model =
                    typeof frontmatter?.model === "string"
                        ? frontmatter.model
                        : undefined;
                const numCtx = parsePositiveInteger(frontmatter?.num_ctx);
                const temperature = parseParameterWithConstraint(
                    frontmatter,
                    ["temperature", "temp"],
                    (val) => val >= 0,
                );
                const topP = parseParameterWithConstraint(
                    frontmatter,
                    ["top_p", "topP", "top-p"],
                    (val) => val > 0,
                );
                const topK = parsePositiveInteger(
                    frontmatter?.top_k ??
                        frontmatter?.topK ??
                        frontmatter?.["top-k"],
                );
                const repeatPenalty = parseParameterWithConstraint(
                    frontmatter,
                    ["repeat_penalty", "repeatPenalty", "repeat-penalty"],
                    (val) => val > 0,
                );
                const includeLinks = parseBoolean(frontmatter?.includeLinks);
                const excludePatterns = compileExcludePatterns(
                    frontmatter?.excludePatterns as optionalStrings,
                );
                const excludeCalloutTypes = normalizeToArray(
                    frontmatter?.excludeCalloutTypes as optionalStrings,
                );
                const filters = normalizeToArray(
                    frontmatter?.filters as optionalStrings,
                );
                const wrapInBlockquote = parseBoolean(
                    frontmatter?.wrapInBlockquote,
                );
                const calloutHeading =
                    typeof frontmatter?.calloutHeading === "string"
                        ? frontmatter.calloutHeading
                        : undefined;
                const connection =
                    typeof frontmatter?.connection === "string"
                        ? frontmatter.connection
                        : undefined;
                const context = parseContextMode(frontmatter?.context);

                // Strip frontmatter from prompt content
                const promptText = this.stripFrontmatter(promptContent);
                return {
                    prompt: promptText,
                    connection,
                    model,
                    numCtx,
                    includeLinks,
                    excludePatterns,
                    excludeCalloutTypes,
                    sourcePath: promptFilePath,
                    temperature,
                    topP,
                    topK,
                    repeatPenalty,
                    filters,
                    wrapInBlockquote,
                    calloutHeading,
                    context,
                };
            } catch (error) {
                new Notice(`Could not read prompt file: ${promptFilePath}`);
                this.logger.logError(error, "Error reading prompt file");
            }
        } else {
            new Notice(`Prompt file not found: ${promptFilePath}`);
            this.logger.logWarn("Prompt file not found", promptFilePath);
        }
        return null;
    };

    stripFrontmatter = (content: string): string => {
        const frontmatterRegex = /^---\n[\s\S]*?\n---\n/;
        return content.replace(frontmatterRegex, "").trim();
    };

    validatePromptFile = async (filePath: string): Promise<string[]> => {
        const errors: string[] = [];
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            errors.push(`File not found: ${filePath}`);
            return errors;
        }

        const frontmatter =
            this.app.metadataCache.getFileCache(file)?.frontmatter;

        if (!frontmatter) {
            return errors; // No frontmatter is valid — uses defaults
        }

        const fm = frontmatter as Record<string, unknown>;

        // connection
        if (fm.connection !== undefined) {
            if (typeof fm.connection !== "string" || !fm.connection.trim()) {
                errors.push("`connection` must be a non-empty string");
            } else if (!this.settings.connections[fm.connection]) {
                errors.push(
                    `connection "${fm.connection}" not found in settings`,
                );
            }
        }

        // model
        if (fm.model !== undefined) {
            if (typeof fm.model !== "string" || !fm.model.trim()) {
                errors.push("`model` must be a non-empty string");
            }
        }

        // num_ctx
        if (
            fm.num_ctx !== undefined &&
            parsePositiveInteger(fm.num_ctx) === undefined
        ) {
            errors.push("`num_ctx` must be a positive integer");
        }

        // temperature / temp
        const tempVal = fm.temperature ?? fm.temp;
        if (tempVal !== undefined) {
            const t = parseParameterWithConstraint(
                fm,
                ["temperature", "temp"],
                (v) => v >= 0,
            );
            if (t === undefined) {
                errors.push("`temperature` must be a number >= 0");
            }
        }

        // top_p
        const topPVal = fm.top_p ?? fm.topP ?? fm["top-p"];
        if (topPVal !== undefined) {
            const tp = parseParameterWithConstraint(
                fm,
                ["top_p", "topP", "top-p"],
                (v) => v > 0,
            );
            if (tp === undefined) {
                errors.push("`top_p` must be a number > 0");
            }
        }

        // top_k
        const topKRaw = fm.top_k ?? fm.topK ?? fm["top-k"];
        if (
            topKRaw !== undefined &&
            parsePositiveInteger(topKRaw) === undefined
        ) {
            errors.push("`top_k` must be a positive integer");
        }

        // repeat_penalty
        const rpVal =
            fm.repeat_penalty ?? fm.repeatPenalty ?? fm["repeat-penalty"];
        if (rpVal !== undefined) {
            const rp = parseParameterWithConstraint(
                fm,
                ["repeat_penalty", "repeatPenalty", "repeat-penalty"],
                (v) => v > 0,
            );
            if (rp === undefined) {
                errors.push("`repeat_penalty` must be a number > 0");
            }
        }

        // includeLinks
        if (
            fm.includeLinks !== undefined &&
            parseBoolean(fm.includeLinks) === undefined
        ) {
            errors.push("`includeLinks` must be true or false");
        }

        // wrapInBlockquote
        if (
            fm.wrapInBlockquote !== undefined &&
            parseBoolean(fm.wrapInBlockquote) === undefined
        ) {
            errors.push("`wrapInBlockquote` must be true or false");
        }

        // context
        if (fm.context !== undefined) {
            if (!CONTEXT_MODES.includes(fm.context as never)) {
                errors.push(
                    `\`context\` must be one of: ${CONTEXT_MODES.join(", ")}`,
                );
            }
        }

        // filters
        if (fm.filters !== undefined) {
            const isValid =
                typeof fm.filters === "string" ||
                (Array.isArray(fm.filters) &&
                    fm.filters.every((f) => typeof f === "string"));
            if (!isValid) {
                errors.push("`filters` must be a string or list of strings");
            }
        }

        // excludeCalloutTypes
        if (fm.excludeCalloutTypes !== undefined) {
            const isValid =
                typeof fm.excludeCalloutTypes === "string" ||
                (Array.isArray(fm.excludeCalloutTypes) &&
                    fm.excludeCalloutTypes.every((f) => typeof f === "string"));
            if (!isValid) {
                errors.push(
                    "`excludeCalloutTypes` must be a string or list of strings",
                );
            }
        }

        return errors;
    };
}
