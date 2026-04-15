import { Input, matchesKey } from "@mariozechner/pi-tui";
import type { Component, TUI } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { QuestionCategory } from "../commands/spec-utils.js";

export type { QuestionCategory };

export class QuestionWizard implements Component {
  private activeTab = 0;
  private activeFocusIndex = 0;
  private readonly inputs: Input[][];
  private readonly validationErrors: boolean[][];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly categories: QuestionCategory[],
    private readonly done: (result: Record<string, string[]>) => void,
  ) {
    this.inputs = categories.map(cat => cat.questions.map(() => new Input()));
    this.validationErrors = categories.map(cat => cat.questions.map(() => false));
    this.syncFocus();
  }

  private syncFocus(): void {
    for (let t = 0; t < this.inputs.length; t++) {
      for (let q = 0; q < this.inputs[t].length; q++) {
        this.inputs[t][q].focused = t === this.activeTab && q === this.activeFocusIndex;
      }
    }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "right")) {
      this.activeTab = Math.min(this.activeTab + 1, this.categories.length - 1);
      this.activeFocusIndex = 0;
      this.syncFocus();
      return;
    }
    if (matchesKey(data, "left")) {
      this.activeTab = Math.max(this.activeTab - 1, 0);
      this.activeFocusIndex = 0;
      this.syncFocus();
      return;
    }
    if (matchesKey(data, "tab")) {
      const max = this.inputs[this.activeTab].length - 1;
      this.activeFocusIndex = this.activeFocusIndex >= max ? 0 : this.activeFocusIndex + 1;
      this.syncFocus();
      return;
    }
    if (matchesKey(data, "ctrl+enter")) {
      this.trySubmit();
      return;
    }
    this.inputs[this.activeTab][this.activeFocusIndex].handleInput(data);
    this.tui.requestRender();
  }

  private trySubmit(): void {
    let hasErrors = false;
    for (let t = 0; t < this.inputs.length; t++) {
      for (let q = 0; q < this.inputs[t].length; q++) {
        const empty = this.inputs[t][q].getValue().trim() === "";
        this.validationErrors[t][q] = empty;
        if (empty) hasErrors = true;
      }
    }
    this.tui.requestRender();
    if (hasErrors) return;

    const result: Record<string, string[]> = {};
    for (let t = 0; t < this.categories.length; t++) {
      result[this.categories[t].name] = this.inputs[t].map(inp => inp.getValue().trim());
    }
    this.done(result);
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Tab bar — no outer border
    const tabBar = this.categories
      .map((cat, i) =>
        i === this.activeTab
          ? this.theme.fg("accent", ` ${cat.name} `)
          : this.theme.fg("muted", ` ${cat.name} `),
      )
      .join("  ");
    lines.push(tabBar);
    lines.push("");

    // Active category questions and inputs
    const cat = this.categories[this.activeTab];
    for (let q = 0; q < cat.questions.length; q++) {
      const hasError = this.validationErrors[this.activeTab][q];
      lines.push(this.theme.fg(hasError ? "error" : "muted", cat.questions[q]));
      lines.push(...this.inputs[this.activeTab][q].render(width));
      lines.push("");
    }

    lines.push(this.theme.fg("muted", "→/← category  Tab next field  Ctrl+Enter submit"));
    return lines;
  }

  invalidate(): void {
    for (const row of this.inputs) {
      for (const inp of row) {
        inp.invalidate();
      }
    }
  }
}
