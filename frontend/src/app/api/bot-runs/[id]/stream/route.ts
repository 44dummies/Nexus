import { NextRequest } from 'next/server';

export const runtime = 'nodejs';

const getBackendBaseUrl = () => {
    const base = process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || '';
    return base.replace(/\/$/, '');
};

/**
 * SSE proxy for bot-run live event stream.
 * Forwards the EventSource connection from the frontend to the backend
 * so that CORS and cookie-based auth work through the Next.js proxy layer.
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const backendBaseUrl = getBackendBaseUrl();
    if (!backendBaseUrl) {
        return new Response(JSON.stringify({ error: 'Missing API base URL' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const streamUrl = new URL(`/api/bot-runs/${id}/stream`, backendBaseUrl);

    try {
        const backendResponse = await fetch(streamUrl.toString(), {
            method: 'GET',
            headers: {
                cookie: request.headers.get('cookie') || '',
                Accept: 'text/event-stream',
            },
            // @ts-expect-error - duplex is required for streaming but not in TS types
            duplex: 'half',
        });

        if (!backendResponse.ok || !backendResponse.body) {
            const text = await backendResponse.text().catch(() => 'Unknown error');
            return new Response(JSON.stringify({ error: text }), {
                status: backendResponse.status,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Stream the SSE response through to the client
        return new Response(backendResponse.body, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
            },
        });
    } catch (error) {
        return new Response(
            JSON.stringify({ error: 'Bot stream proxy failed', details: (error as Error).message }),
            { status: 502, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
