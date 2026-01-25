import fs from 'fs';
import path from 'path';

type RecordedEvent =
    | { type: 'tick'; symbol: string; ts: number; quote: number }
    | { type: 'order_book'; symbol: string; ts: number; bids: unknown; asks: unknown };

let stream: fs.WriteStream | null = null;

function ensureStream(): fs.WriteStream | null {
    const filePath = process.env.MARKETDATA_RECORD_PATH;
    if (!filePath) return null;
    if (!stream) {
        const resolved = path.resolve(filePath);
        stream = fs.createWriteStream(resolved, { flags: 'a' });
    }
    return stream;
}

function writeEvent(event: RecordedEvent): void {
    const writer = ensureStream();
    if (!writer) return;
    writer.write(`${JSON.stringify(event)}\n`);
}

export function recordTick(symbol: string, quote: number, ts: number): void {
    writeEvent({ type: 'tick', symbol, ts, quote });
}

export function recordOrderBook(symbol: string, bids: unknown, asks: unknown, ts: number): void {
    writeEvent({ type: 'order_book', symbol, ts, bids, asks });
}
