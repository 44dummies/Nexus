import { monitorEventLoopDelay, performance } from 'perf_hooks';

export interface HistogramSnapshot {
    count: number;
    sampleSize: number;
    min: number | null;
    max: number | null;
    mean: number | null;
    p50: number | null;
    p90: number | null;
    p99: number | null;
}

class FixedHistogram {
    private samples: Float64Array;
    private sorted: Float64Array;
    private capacity: number;
    private index = 0;
    private sampleCount = 0;
    private countTotal = 0;
    private sumTotal = 0;
    private minTotal = Number.POSITIVE_INFINITY;
    private maxTotal = Number.NEGATIVE_INFINITY;

    constructor(capacity: number) {
        this.capacity = capacity;
        this.samples = new Float64Array(capacity);
        this.sorted = new Float64Array(capacity);
    }

    private findInsertIndex(value: number, count: number): number {
        let lo = 0;
        let hi = count;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.sorted[mid] < value) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    private findValueIndex(value: number, count: number): number {
        let lo = 0;
        let hi = count;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.sorted[mid] < value) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        for (let i = lo; i < count; i++) {
            const current = this.sorted[i];
            if (current === value) return i;
            if (current > value) break;
        }
        return -1;
    }

    record(value: number): void {
        if (!Number.isFinite(value)) return;
        this.countTotal += 1;
        this.sumTotal += value;
        if (value < this.minTotal) this.minTotal = value;
        if (value > this.maxTotal) this.maxTotal = value;

        if (this.sampleCount < this.capacity) {
            const insertIndex = this.findInsertIndex(value, this.sampleCount);
            for (let i = this.sampleCount; i > insertIndex; i--) {
                this.sorted[i] = this.sorted[i - 1];
            }
            this.sorted[insertIndex] = value;

            this.samples[this.index] = value;
            this.index = (this.index + 1) % this.capacity;
            this.sampleCount += 1;
            return;
        }

        const oldValue = this.samples[this.index];
        const removeIndex = this.findValueIndex(oldValue, this.sampleCount);
        if (removeIndex >= 0) {
            for (let i = removeIndex; i < this.sampleCount - 1; i++) {
                this.sorted[i] = this.sorted[i + 1];
            }
        }

        const insertIndex = this.findInsertIndex(value, this.sampleCount - 1);
        for (let i = this.sampleCount - 1; i > insertIndex; i--) {
            this.sorted[i] = this.sorted[i - 1];
        }
        this.sorted[insertIndex] = value;

        this.samples[this.index] = value;
        this.index = (this.index + 1) % this.capacity;
    }

    snapshot(): HistogramSnapshot {
        if (this.sampleCount === 0) {
            return {
                count: this.countTotal,
                sampleSize: 0,
                min: null,
                max: null,
                mean: null,
                p50: null,
                p90: null,
                p99: null,
            };
        }

        const quantile = (p: number) => {
            if (this.sampleCount === 0) return null;
            const idx = Math.min(this.sampleCount - 1, Math.max(0, Math.floor(p * (this.sampleCount - 1))));
            return this.sorted[idx];
        };

        const mean = this.countTotal > 0 ? this.sumTotal / this.countTotal : null;

        return {
            count: this.countTotal,
            sampleSize: this.sampleCount,
            min: Number.isFinite(this.minTotal) ? this.minTotal : null,
            max: Number.isFinite(this.maxTotal) ? this.maxTotal : null,
            mean,
            p50: quantile(0.5),
            p90: quantile(0.9),
            p99: quantile(0.99),
        };
    }
}

const DEFAULT_HISTOGRAM_SIZE = Number(process.env.METRICS_HISTOGRAM_SIZE) || 2048;

const histograms = new Map<string, FixedHistogram>();
const counters = new Map<string, number>();
const gauges = new Map<string, number>();

const eventLoopMonitor = monitorEventLoopDelay({ resolution: 10 });
let eventLoopEnabled = false;

let lastCpuUsage = process.cpuUsage();
let lastCpuSnapshotAt = performance.now();

function getHistogram(name: string): FixedHistogram {
    let hist = histograms.get(name);
    if (!hist) {
        hist = new FixedHistogram(DEFAULT_HISTOGRAM_SIZE);
        histograms.set(name, hist);
    }
    return hist;
}

export const metrics = {
    histogram(name: string, value: number) {
        getHistogram(name).record(value);
    },
    counter(name: string, inc: number = 1) {
        const next = (counters.get(name) || 0) + inc;
        counters.set(name, next);
    },
    gauge(name: string, value: number) {
        gauges.set(name, value);
    },
    snapshot() {
        if (!eventLoopEnabled) {
            eventLoopMonitor.enable();
            eventLoopEnabled = true;
        }

        const hist: Record<string, HistogramSnapshot> = {};
        for (const [name, h] of histograms.entries()) {
            hist[name] = h.snapshot();
        }

        const counterValues: Record<string, number> = {};
        for (const [name, value] of counters.entries()) {
            counterValues[name] = value;
        }

        const gaugeValues: Record<string, number> = {};
        for (const [name, value] of gauges.entries()) {
            gaugeValues[name] = value;
        }

        const now = performance.now();
        const cpuDelta = process.cpuUsage(lastCpuUsage);
        const elapsedMs = now - lastCpuSnapshotAt;
        const userMs = cpuDelta.user / 1000;
        const systemMs = cpuDelta.system / 1000;
        const cpuPercent = elapsedMs > 0 ? ((userMs + systemMs) / elapsedMs) * 100 : 0;

        lastCpuUsage = process.cpuUsage();
        lastCpuSnapshotAt = now;

        const eventLoop = {
            p50: eventLoopMonitor.percentile(50) / 1e6,
            p90: eventLoopMonitor.percentile(90) / 1e6,
            p99: eventLoopMonitor.percentile(99) / 1e6,
            max: eventLoopMonitor.max / 1e6,
            mean: eventLoopMonitor.mean / 1e6,
        };

        return {
            timestamp: new Date().toISOString(),
            uptimeSec: process.uptime(),
            histograms: hist,
            counters: counterValues,
            gauges: gaugeValues,
            eventLoopLagMs: eventLoop,
            memory: process.memoryUsage(),
            cpu: {
                userMs,
                systemMs,
                percent: cpuPercent,
            },
        };
    },
};

export function initMetrics(): void {
    if (!eventLoopEnabled) {
        eventLoopMonitor.enable();
        eventLoopEnabled = true;
    }
}
