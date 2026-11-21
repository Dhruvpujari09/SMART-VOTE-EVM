import { useEffect, useRef, useState } from 'react';

export interface GatewayEventMessage {
  id: string;
  event: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export function useGatewaySocket(enabled: boolean) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<GatewayEventMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let unmounted = false;

    const connect = () => {
      if (unmounted) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?role=dashboard`;

      try {
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!unmounted) setConnected(true);
        };

        ws.onmessage = (evt) => {
          try {
            const parsed = JSON.parse(String(evt.data));
            const entry: GatewayEventMessage = {
              id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              event: String(parsed.event || 'unknown'),
              timestamp: String(parsed.timestamp || new Date().toISOString()),
              payload: (parsed.payload || {}) as Record<string, unknown>,
            };
            setEvents((prev) => [entry, ...prev].slice(0, 40));
          } catch {
            // Ignore malformed socket frames
          }
        };

        ws.onclose = () => {
          if (!unmounted) {
            setConnected(false);
            reconnectTimerRef.current = window.setTimeout(connect, 3500);
          }
        };

        ws.onerror = () => {
          ws.close();
        };
      } catch {
        if (!unmounted) {
          setConnected(false);
          reconnectTimerRef.current = window.setTimeout(connect, 4000);
        }
      }
    };

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, [enabled]);

  return { connected, events };
}
