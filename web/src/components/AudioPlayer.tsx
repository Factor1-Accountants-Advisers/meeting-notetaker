"use client";

import { useRef, forwardRef, useImperativeHandle } from "react";

export interface AudioPlayerHandle {
  seekTo: (seconds: number) => void;
}

interface AudioPlayerProps {
  src: string | null;
}

const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  function AudioPlayer({ src }, ref) {
    const audioRef = useRef<HTMLAudioElement>(null);

    useImperativeHandle(ref, () => ({
      seekTo(seconds: number) {
        if (audioRef.current) {
          audioRef.current.currentTime = seconds;
          audioRef.current.play();
        }
      },
    }));

    if (!src) return null;

    return (
      <div className="surface-card rounded-[24px] border border-[color:var(--border-subtle)] p-4 shadow-[var(--shadow-soft)]">
        <audio
          ref={audioRef}
          controls
          src={src}
          className="w-full rounded-2xl"
        />
      </div>
    );
  }
);

export default AudioPlayer;
