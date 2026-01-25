export interface OrderBookLevel {
    price: number;
    size: number;
}

export interface OrderBookSnapshot {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    symbol: string;
    serverTime?: number;
}

export class OrderBook {
    private bids: OrderBookLevel[] = [];
    private asks: OrderBookLevel[] = [];
    private symbol: string;
    private updatedAtMs: number = 0;

    constructor(symbol: string) {
        this.symbol = symbol;
    }

    updateFromSnapshot(snapshot: OrderBookSnapshot): void {
        this.symbol = snapshot.symbol;
        this.bids = (snapshot.bids || []).slice().sort((a, b) => b.price - a.price);
        this.asks = (snapshot.asks || []).slice().sort((a, b) => a.price - b.price);
        this.updatedAtMs = Date.now();
    }

    getBestBid(): OrderBookLevel | null {
        return this.bids.length > 0 ? this.bids[0] : null;
    }

    getBestAsk(): OrderBookLevel | null {
        return this.asks.length > 0 ? this.asks[0] : null;
    }

    getSpread(): number | null {
        const bid = this.getBestBid();
        const ask = this.getBestAsk();
        if (!bid || !ask) return null;
        return ask.price - bid.price;
    }

    getMid(): number | null {
        const bid = this.getBestBid();
        const ask = this.getBestAsk();
        if (!bid || !ask) return null;
        return (bid.price + ask.price) / 2;
    }

    getMicroPrice(): number | null {
        const bid = this.getBestBid();
        const ask = this.getBestAsk();
        if (!bid || !ask) return null;
        const denom = bid.size + ask.size;
        if (denom <= 0) return null;
        return (bid.price * ask.size + ask.price * bid.size) / denom;
    }

    getImbalanceTopN(levels: number): number | null {
        const depth = Math.max(1, Math.floor(levels));
        const bidSlice = this.bids.slice(0, depth);
        const askSlice = this.asks.slice(0, depth);
        if (bidSlice.length === 0 && askSlice.length === 0) return null;

        let bidSum = 0;
        let askSum = 0;
        for (const level of bidSlice) bidSum += level.size;
        for (const level of askSlice) askSum += level.size;
        const denom = bidSum + askSum;
        if (denom <= 0) return null;
        return (bidSum - askSum) / denom;
    }

    getUpdatedAtMs(): number {
        return this.updatedAtMs;
    }
}
