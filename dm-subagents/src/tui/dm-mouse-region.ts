import { type Component, type TuiMouseEvent } from "@duckmind/dm-tui";

export class MouseRegion implements Component {
	private readonly child: Component;
	private readonly onMouse: (event: TuiMouseEvent) => { handled: boolean; render?: boolean } | undefined;

	constructor(child: Component, onMouse: (event: TuiMouseEvent) => { handled: boolean; render?: boolean } | undefined) {
		this.child = child;
		this.onMouse = onMouse;
	}

	render(width: number): string[] {
		return this.child.render(width);
	}

	invalidate(): void {
		this.child.invalidate();
	}

	handleMouse(event: TuiMouseEvent): { handled: boolean; render?: boolean } | undefined {
		if (
			event.type !== "click" || event.button !== "left" ||
			event.shift || event.alt || event.ctrl ||
			event.x < 0 || event.x >= event.width || event.y < 0 || event.y >= this.child.render(event.width).length
		) return undefined;
		const result = this.onMouse(event);
		return result?.handled ? { ...result, render: result.render ?? true } : result;
	}
}
