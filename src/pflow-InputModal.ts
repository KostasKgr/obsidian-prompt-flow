import { type App, Modal, Setting } from "obsidian";

export class InputModal extends Modal {
    private resolve!: (v: string | null) => void;
    private settled = false;

    constructor(
        app: App,
        private question: string,
    ) {
        super(app);
    }

    prompt(): Promise<string | null> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onOpen() {
        this.setTitle(this.question);
        let value = "";
        let inputEl!: HTMLTextAreaElement;

        new Setting(this.contentEl).addTextArea((ta) => {
            ta.setPlaceholder("…").onChange((v) => {
                value = v;
            });
            ta.inputEl.rows = 3;
            ta.inputEl.setCssProps({ width: "100%" });
            inputEl = ta.inputEl;
        });

        new Setting(this.contentEl)
            .addButton((b) =>
                b
                    .setButtonText("Submit")
                    .setCta()
                    .onClick(() => this.finish(value)),
            )
            .addButton((b) =>
                b.setButtonText("Cancel").onClick(() => this.finish(null)),
            );

        window.setTimeout(() => inputEl?.focus(), 30);
        this.contentEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this.finish(value);
            }
        });
    }

    onClose() {
        this.finish(null);
        this.contentEl.empty();
    }

    private finish(value: string | null) {
        if (this.settled) return;
        this.settled = true;
        this.resolve(value === null ? null : value.trim());
        this.close();
    }
}
