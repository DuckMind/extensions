/** Overlay-local scrolling; DM 0.77 does not export the upstream ScrollView. */
export class FleetViewport {
	readonly scroll = {
		scrollTop: 0,
		viewportHeight: 0,
		isFollowingEnd: true,
		scrollBy: (delta: number) => this.move(this.scroll.scrollTop + delta),
		scrollTo: (top: number, options?: { disableFollow?: boolean }) => {
			this.move(top);
			if (options?.disableFollow) this.scroll.isFollowingEnd = false;
		},
		scrollToEnd: () => {
			this.scroll.isFollowingEnd = true;
			this.move(this.maxTop());
		},
	};
	private lineCount = 0;
	private resetTopOnLayout = false;
	private readonly requestRender: () => void;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	private maxTop(): number {
		return Math.max(0, this.lineCount - this.scroll.viewportHeight);
	}

	private move(top: number): void {
		const next = Math.max(0, Math.min(this.maxTop(), top));
		if (next === this.scroll.scrollTop) return;
		this.scroll.scrollTop = next;
		this.scroll.isFollowingEnd = next === this.maxTop();
		this.requestRender();
	}

	render(lines: string[], _width: number, height: number): string[] {
		this.lineCount = lines.length;
		this.scroll.viewportHeight = Math.max(0, height);
		if (this.resetTopOnLayout) {
			this.resetTopOnLayout = false;
			this.scroll.scrollTop = 0;
			this.scroll.isFollowingEnd = false;
		} else if (this.scroll.isFollowingEnd) {
			this.scroll.scrollTop = this.maxTop();
		} else {
			this.scroll.scrollTop = Math.min(this.scroll.scrollTop, this.maxTop());
			if (this.scroll.scrollTop === this.maxTop() && lines.length > height) this.scroll.isFollowingEnd = true;
		}
		return lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.scroll.viewportHeight);
	}

	resetTop(): void {
		this.resetTopOnLayout = true;
		this.scroll.scrollTop = 0;
		this.scroll.isFollowingEnd = false;
	}

	follow(): void {
		this.resetTopOnLayout = false;
		this.scroll.scrollToEnd();
	}
}
