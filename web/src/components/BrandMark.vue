<template>
  <!-- The project's mark, drawn inline (no external asset under the CSP): three
       isometric planes; one message enters the top plane and is
       routed to two lanes on the middle one. The ink is the surrounding text's
       color, the top plane's face the page's own ground, so it reads in both
       themes; the route is the dashboard's `ok` green. -->
  <svg
    viewBox="0 0 64 64"
    class="mark inline-block size-[1.35em] shrink-0 align-[-0.3em]"
    aria-label="OpenSwitchboard"
    role="img"
  >
    <g transform="translate(0 2)" stroke-linejoin="round" stroke-linecap="round" stroke-width="4">
      <polygon points="32,30 59,43 32,56 5,43" fill="none" stroke="currentColor" />
      <polygon points="32,17 59,30 32,43 5,30" fill="currentColor" stroke="currentColor" />
      <polygon points="32,4 59,17 32,30 5,17" fill="var(--ui-bg)" stroke="currentColor" />
      <path d="M32 17 L32 30 L19 37 M32 30 L45 37" fill="none" stroke="var(--sb-ok)" />
      <circle cx="32" cy="17" r="4" fill="var(--sb-ok)" stroke="var(--ui-bg)" stroke-width="3" />
      <circle cx="19" cy="37" r="4" fill="var(--sb-ok)" stroke="currentColor" stroke-width="3" />
      <circle cx="45" cy="37" r="4" fill="var(--sb-ok)" stroke="currentColor" stroke-width="3" />
    </g>
  </svg>
</template>
