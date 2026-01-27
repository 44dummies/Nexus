import { metrics } from './metrics';

type Task<T> = () => Promise<T>;

interface QueueItem<T> {
    task: Task<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
}

export class AsyncTaskQueue {
    private name: string;
    private concurrency: number;
    private maxDepth: number;
    private queue: QueueItem<unknown>[] = [];
    private running = 0;
    private scheduled = false;

    constructor(name: string, concurrency: number, maxDepth: number) {
        this.name = name;
        this.concurrency = Math.max(1, Math.floor(concurrency));
        this.maxDepth = Math.max(1, Math.floor(maxDepth));
    }

    enqueue<T>(task: Task<T>): Promise<T> {
        if (this.queue.length >= this.maxDepth) {
            return Promise.reject(new Error(`${this.name} queue full`));
        }
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.updateMetrics();
            this.schedule();
        });
    }

    private schedule(): void {
        if (this.scheduled) return;
        this.scheduled = true;
        setImmediate(() => {
            this.scheduled = false;
            this.drain().catch(() => undefined);
        });
    }

    private async drain(): Promise<void> {
        while (this.running < this.concurrency && this.queue.length > 0) {
            const item = this.queue.shift() as QueueItem<unknown>;
            this.running += 1;
            this.updateMetrics();
            void this.runItem(item);
        }

        if (this.queue.length > 0 && this.running < this.concurrency) {
            this.schedule();
        }
    }

    private async runItem(item: QueueItem<unknown>): Promise<void> {
        try {
            const result = await item.task();
            item.resolve(result as never);
        } catch (error) {
            item.reject(error as Error);
        } finally {
            this.running = Math.max(0, this.running - 1);
            this.updateMetrics();
            if (this.queue.length > 0) {
                this.schedule();
            }
        }
    }

    private updateMetrics(): void {
        metrics.gauge(`${this.name}.queue_depth`, this.queue.length);
        metrics.gauge(`${this.name}.in_flight`, this.running);
    }
}

const QUEUE_CONCURRENCY = Math.max(1, Number(process.env.PERSIST_QUEUE_CONCURRENCY) || 2);
const QUEUE_MAX_DEPTH = Math.max(100, Number(process.env.PERSIST_QUEUE_MAX_DEPTH) || 10_000);

export const persistenceQueue = new AsyncTaskQueue('persistence', QUEUE_CONCURRENCY, QUEUE_MAX_DEPTH);
