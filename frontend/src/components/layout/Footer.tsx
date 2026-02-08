'use client';

export default function Footer() {
    return (
        <footer className="border-t border-border/50 bg-background/80 backdrop-blur">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-1.5 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <span className="font-medium text-foreground/80">44dummies</span>
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
                    <span>
                        Email:{' '}
                        <a
                            href="mailto:muindidamian@gmail.com"
                            className="text-foreground/90 hover:text-foreground transition-colors"
                        >
                            muindidamian@gmail.com
                        </a>
                    </span>
                    <span>
                        Phone:{' '}
                        <a
                            href="tel:0728922703"
                            className="text-foreground/90 hover:text-foreground transition-colors"
                        >
                            0728922703
                        </a>
                    </span>
                </div>
            </div>
        </footer>
    );
}
