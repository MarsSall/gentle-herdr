import { truncateToWidth } from "@earendil-works/pi-tui";

interface ChoiceListOptions {
 title: string;
 options: readonly string[];
 current: number;
 preview(index: number): string[];
 keybindings: { matches(data: string, key: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): boolean };
 requestRender(): void;
 done(index: number | undefined): void;
}
/** Highlight is local UI state only; callers decide what confirmation means. */
export function createHerdrChoiceList(options: ChoiceListOptions) {
 let highlighted = Math.max(0, Math.min(options.current, options.options.length - 1));
 return {
  render(width: number): string[] {
   const lines = [options.title, ...options.options.map((label, index) =>
    `${index === highlighted ? ">" : " "} ${label}${index === options.current ? " (current)" : ""}`),
    "", "Preview (not applied)", ...(options.options.length ? options.preview(highlighted) : [])];
   return lines.flatMap(line => line.split("\n")).map(line => width <= 0 ? "" : truncateToWidth(line, width, ""));
  },
  handleInput(data: string): void {
   const keys = options.keybindings;
   if (keys.matches(data, "tui.select.cancel")) options.done(undefined);
   else if (keys.matches(data, "tui.select.confirm")) options.done(options.options.length ? highlighted : undefined);
   else if (keys.matches(data, "tui.select.up")) {
    highlighted = Math.max(0, highlighted - 1); options.requestRender();
   } else if (keys.matches(data, "tui.select.down")) {
    highlighted = Math.min(options.options.length - 1, highlighted + 1); options.requestRender();
   }
  },
  invalidate(): void {},
 };
}
