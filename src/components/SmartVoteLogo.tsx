import React from 'react';

interface SmartVoteLogoProps {
  size?: 'sm' | 'md' | 'lg';
  showSubtitle?: boolean;
}

export const SmartVoteLogo: React.FC<SmartVoteLogoProps> = ({
  size = 'md',
  showSubtitle = false,
}) => {
  const iconDim =
    size === 'lg' ? 'w-14 h-14' : size === 'md' ? 'w-11 h-11' : 'w-9 h-9';
  const titleClass =
    size === 'lg'
      ? 'text-3xl font-extrabold tracking-tight'
      : size === 'md'
        ? 'text-2xl font-extrabold tracking-tight'
        : 'text-xl font-bold tracking-tight';

  return (
    <div className="inline-flex items-center gap-3.5 select-none">
      <svg
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`${iconDim} shrink-0 drop-shadow-[0_0_12px_rgba(56,189,248,0.28)]`}
        aria-hidden="true"
      >
        <rect
          x="2"
          y="2"
          width="60"
          height="60"
          rx="14"
          fill="#0F172A"
          stroke="#1E293B"
          strokeWidth="2.5"
        />
        <path
          d="M32 10L51 17.5V31.5C51 43.2 42.9 52.1 32 55.5C21.1 52.1 13 43.2 13 31.5V17.5L32 10Z"
          fill="#131C2E"
          stroke="#38BDF8"
          strokeWidth="2.8"
          strokeLinejoin="round"
        />
        <circle
          cx="32"
          cy="32"
          r="13.5"
          stroke="#38BDF8"
          strokeOpacity="0.28"
          strokeWidth="1.5"
          strokeDasharray="3.5 3"
        />
        <path
          d="M25.5 32.5L30.2 37.2L39.5 26.8"
          stroke="#38BDF8"
          strokeWidth="3.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      <div className="leading-none">
        <span className={`block font-display text-slate-50 whitespace-nowrap ${titleClass}`}>
          Smart <span className="text-sky-400">Vote</span>
        </span>
        {showSubtitle && (
          <span className="block text-[11px] font-mono text-slate-400 tracking-wide mt-1 whitespace-nowrap">
            ESP32 EVM Console
          </span>
        )}
      </div>
    </div>
  );
};
