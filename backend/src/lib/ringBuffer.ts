export interface PriceSeries {
    length: number;
    get(index: number): number;
    toArray(): number[];
}

export class RingBuffer implements PriceSeries {
    private buffer: Float64Array;
    private capacity: number;
    private size = 0;
    private writeIndex = 0;

    constructor(capacity: number) {
        this.capacity = Math.max(1, Math.floor(capacity));
        this.buffer = new Float64Array(this.capacity);
    }

    push(value: number): void {
        this.buffer[this.writeIndex] = value;
        this.writeIndex = (this.writeIndex + 1) % this.capacity;
        if (this.size < this.capacity) {
            this.size += 1;
        }
    }

    clear(): void {
        this.size = 0;
        this.writeIndex = 0;
    }

    get length(): number {
        return this.size;
    }

    get(index: number): number {
        if (index < 0 || index >= this.size) return Number.NaN;
        const start = (this.writeIndex - this.size + this.capacity) % this.capacity;
        const idx = (start + index) % this.capacity;
        return this.buffer[idx];
    }

    getLatest(): number | null {
        if (this.size === 0) return null;
        return this.get(this.size - 1);
    }

    getView(windowSize: number): RingBufferView {
        const len = Math.min(this.size, Math.max(0, Math.floor(windowSize)));
        const startOffset = Math.max(0, this.size - len);
        return new RingBufferView(this, startOffset, len);
    }

    toArray(): number[] {
        const arr = new Array<number>(this.size);
        for (let i = 0; i < this.size; i++) {
            arr[i] = this.get(i);
        }
        return arr;
    }
}

export class RingBufferView implements PriceSeries {
    private parent: RingBuffer;
    private offset: number;
    private size: number;

    constructor(parent: RingBuffer, offset: number, size: number) {
        this.parent = parent;
        this.offset = offset;
        this.size = size;
    }

    get length(): number {
        return this.size;
    }

    get(index: number): number {
        if (index < 0 || index >= this.size) return Number.NaN;
        return this.parent.get(this.offset + index);
    }

    toArray(): number[] {
        const arr = new Array<number>(this.size);
        for (let i = 0; i < this.size; i++) {
            arr[i] = this.get(i);
        }
        return arr;
    }
}
