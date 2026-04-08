"use client";

import { useRef, useEffect, useImperativeHandle, forwardRef, useState } from "react";

export interface AudioPlayerHandle {
  seekTo: (seconds: number) => void;
}

interface AudioPlayerProps {
  src: string | null;
  onTimeUpdate?: (currentTime: number) => void;
}

const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  function AudioPlayer({ src, onTimeUpdate }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wavesurferRef = useRef<any>(null);
    const pendingSeekRef = useRef<number | null>(null);
    const [loadError, setLoadError] = useState(false);

    useImperativeHandle(ref, () => ({
      seekTo(seconds: number) {
        const ws = wavesurferRef.current;
        if (!ws) return;
        const duration = ws.getDuration();
        if (duration > 0) {
          ws.seekTo(seconds / duration);
        } else {
          pendingSeekRef.current = seconds;
        }
      },
    }));

    useEffect(() => {
      if (!src || !containerRef.current) return;

      let destroyed = false;

      import("wavesurfer.js").then(({ default: WaveSurfer }) => {
        if (destroyed) return;

        const style = getComputedStyle(document.documentElement);
        const waveColor = style.getPropertyValue("--border-subtle").trim() || "#d1d5db";
        const progressColor = style.getPropertyValue("--accent-text").trim() || "#6366f1";

        const ws = WaveSurfer.create({
          container: containerRef.current!,
          url: src,
          waveColor,
          progressColor,
          height: 64,
          barWidth: 2,
          barRadius: 2,
          interact: true,
        });

        wavesurferRef.current = ws;

        ws.on("ready", () => {
          if (pendingSeekRef.current !== null) {
            const duration = ws.getDuration();
            if (duration > 0) {
              ws.seekTo(pendingSeekRef.current / duration);
            }
            pendingSeekRef.current = null;
          }
        });

        ws.on("timeupdate", (currentTime: number) => {
          onTimeUpdate?.(currentTime);
        });

        ws.on("error", () => {
          if (!destroyed) setLoadError(true);
        });
      });

      return () => {
        destroyed = true;
        wavesurferRef.current?.destroy();
        wavesurferRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src]);

    if (!src) return null;

    if (loadError) {
      return (
        <div className="surface-card rounded-[24px] border border-[color:var(--border-subtle)] p-4 shadow-[var(--shadow-soft)]">
          <p className="text-sm text-[color:var(--text-secondary)]">Audio could not be loaded.</p>
        </div>
      );
    }

    return (
      <div className="surface-card rounded-[24px] border border-[color:var(--border-subtle)] p-4 shadow-[var(--shadow-soft)]">
        <div ref={containerRef} className="w-full" />
      </div>
    );
  }
);

export default AudioPlayer;
