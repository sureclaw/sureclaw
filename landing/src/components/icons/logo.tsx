export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Stylized "ax" lettermark */}
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="8"
        fill="url(#logo-gradient)"
        fillOpacity="0.12"
        stroke="url(#logo-gradient)"
        strokeWidth="1.2"
      />
      {/* "a" */}
      <path
        d="M8.5 22V18.5C8.5 16 10 14 12.5 14C15 14 16 15.5 16 17.5V22M16 19H8.5"
        stroke="url(#logo-gradient)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* "x" */}
      <path
        d="M18.5 14L24.5 22M24.5 14L18.5 22"
        stroke="url(#logo-gradient)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <defs>
        <linearGradient
          id="logo-gradient"
          x1="2"
          y1="2"
          x2="30"
          y2="30"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-glow)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function LogoLarge({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* "a" — larger, bolder */}
      <path
        d="M16 50V40C16 32 22 26 30 26C38 26 42 31 42 38V50M42 43H16"
        stroke="url(#logo-lg-gradient)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* "x" — larger, bolder */}
      <path
        d="M58 26L88 50M88 26L58 50"
        stroke="url(#logo-lg-gradient)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Subtle dot accent */}
      <circle cx="104" cy="48" r="4" fill="url(#logo-lg-gradient)" fillOpacity="0.6" />
      <defs>
        <linearGradient
          id="logo-lg-gradient"
          x1="10"
          y1="20"
          x2="110"
          y2="55"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-glow)" />
        </linearGradient>
      </defs>
    </svg>
  );
}
