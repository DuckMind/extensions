import { type Component } from "@duckmind/dm-tui";

// The bundled TUI has no MouseRegion. Preserve the visible, key-expandable
// component; a future host can replace this wrapper with mouse delivery.
export class MouseRegion implements Component {
  private readonly child: Component;
  constructor(child: Component, _onMouse: (event: { type: string; button: string }) => unknown) {
    this.child = child;
  }
  render(width: number): string[] { return this.child.render(width); }
  invalidate(): void { this.child.invalidate(); }
}
