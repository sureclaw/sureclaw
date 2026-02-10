/**
 * Armorclaw Design System
 * Extracted from armorclaw-architecture-overview.html
 * TypeScript version with full type definitions
 */

// ═══════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════

export interface ColorPalette {
  bg: string;
  surface: string;
  surface2: string;
  surface3: string;
  border: string;
  borderAccent: string;
  text: string;
  textDim: string;
  textMuted: string;
  red: string;
  redDim: string;
  redGlow: string;
  orange: string;
  orangeDim: string;
  green: string;
  greenDim: string;
  greenGlow: string;
  blue: string;
  blueDim: string;
  blueGlow: string;
  cyan: string;
  purple: string;
  purpleDim: string;
  yellow: string;
}

export interface Fonts {
  primary: string;
  mono: string;
  importUrl: string;
}

export interface FontSizes {
  h1: string;
  header: string;
  sectionHeader: string;
  body: string;
  bodySmall: string;
  code: string;
  codeSmall: string;
  badge: string;
}

export interface FontWeights {
  light: number;
  regular: number;
  medium: number;
  semibold: number;
  bold: number;
}

export interface LetterSpacing {
  tight: string;
  normal: string;
  wide: string;
  wider: string;
  widest: string;
}

export interface LineHeights {
  tight: number;
  normal: number;
  relaxed: number;
}

export interface Spacing {
  xs: string;
  sm: string;
  md: string;
  lg: string;
  xl: string;
  '2xl': string;
  '3xl': string;
  '4xl': string;
  '5xl': string;
  '6xl': string;
}

export interface BorderRadius {
  sm: string;
  base: string;
  md: string;
  lg: string;
  xl: string;
  '2xl': string;
  full: string;
}

export interface Shadows {
  card: string;
  glow: {
    red: string;
    green: string;
    blue: string;
  };
}

export interface Transitions {
  fast: string;
  base: string;
  all: string;
}

export interface ColorVariant {
  bg: string;
  text: string;
}

export interface TabStyles {
  padding: string;
  borderRadius: string;
  fontSize: string;
  fontWeight: number;
  fontFamily: string;
  colors: {
    default: ColorVariant;
    hover: ColorVariant;
    active: ColorVariant & { shadow: string };
  };
}

export interface ComponentStyles {
  padding: string;
  borderRadius: string;
  fontSize: string;
  fontFamily: string;
  colors: {
    default: ColorVariant & { border: string };
    hover: ColorVariant & { border: string };
  };
}

export interface BadgeVariant {
  bg: string;
  text: string;
}

export interface BadgeStyles {
  padding: string;
  borderRadius: string;
  fontSize: string;
  fontWeight: number;
  letterSpacing: string;
  variants: {
    good: BadgeVariant;
    warn: BadgeVariant;
    neutral: BadgeVariant;
    best: BadgeVariant;
  };
}

export interface StatusStyles {
  padding: string;
  borderRadius: string;
  fontSize: string;
  fontWeight: number;
  letterSpacing: string;
  fontFamily: string;
  variants: {
    on: BadgeVariant;
    off: BadgeVariant;
    limited: BadgeVariant;
    blocked: BadgeVariant;
  };
}

export interface ZoneLabelVariant {
  color: string;
  dotColor: string;
  dotGlow: string;
  badgeBg: string;
  badgeText: string;
}

export interface ZoneLabelStyles {
  fontSize: string;
  fontWeight: number;
  textTransform: string;
  letterSpacing: string;
  fontFamily: string;
  variants: {
    external: ZoneLabelVariant;
    host: ZoneLabelVariant;
    sandbox: ZoneLabelVariant;
  };
}

export interface CardStyles {
  padding: string;
  borderRadius: string;
  border: string;
  bg: string;
}

export interface SectionHeaderStyles {
  fontSize: string;
  fontWeight: number;
  fontFamily: string;
  letterSpacing: string;
  color: string;
  marginBottom: string;
}

export interface Components {
  tab: TabStyles;
  component: ComponentStyles;
  badge: BadgeStyles;
  status: StatusStyles;
  zoneLabel: ZoneLabelStyles;
  card: CardStyles;
  sectionHeader: SectionHeaderStyles;
}

export interface Layout {
  container: {
    maxWidth: string;
    padding: string;
  };
  grid: {
    gap: string;
    gapMd: string;
    gapLg: string;
  };
}

export interface IconSizes {
  dot: string;
  xs: string;
  sm: string;
  base: string;
  lg: string;
  xl: string;
}

export interface DesignSystem {
  fonts: Fonts;
  fontSizes: FontSizes;
  fontWeights: FontWeights;
  letterSpacing: LetterSpacing;
  lineHeights: LineHeights;
  colors: ColorPalette;
  spacing: Spacing;
  borderRadius: BorderRadius;
  shadows: Shadows;
  transitions: Transitions;
  components: Components;
  layout: Layout;
  iconSizes: IconSizes;
}

// ═══════════════════════════════════════════════════════════
// DESIGN SYSTEM
// ═══════════════════════════════════════════════════════════

export const designSystem: DesignSystem = {
  fonts: {
    primary: "'DM Sans', sans-serif",
    mono: "'JetBrains Mono', monospace",
    importUrl: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=DM+Sans:wght@300;400;500;600;700&display=swap"
  },

  fontSizes: {
    h1: '28px',
    header: '14px',
    sectionHeader: '16px',
    body: '13px',
    bodySmall: '12px',
    code: '11px',
    codeSmall: '10px',
    badge: '9px'
  },

  fontWeights: {
    light: 300,
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700
  },

  letterSpacing: {
    tight: '-0.5px',
    normal: '0',
    wide: '0.5px',
    wider: '1px',
    widest: '1.5px'
  },

  lineHeights: {
    tight: 1.4,
    normal: 1.6,
    relaxed: 1.7
  },

  colors: {
    bg: '#0a0c10',
    surface: '#12151c',
    surface2: '#1a1e28',
    surface3: '#222835',
    border: '#2a3040',
    borderAccent: '#3a4560',
    text: '#e2e8f0',
    textDim: '#8892a8',
    textMuted: '#5a6478',
    red: '#ef4444',
    redDim: '#7f1d1d',
    redGlow: 'rgba(239, 68, 68, 0.15)',
    orange: '#f59e0b',
    orangeDim: '#78350f',
    green: '#22c55e',
    greenDim: '#14532d',
    greenGlow: 'rgba(34, 197, 94, 0.1)',
    blue: '#3b82f6',
    blueDim: '#1e3a5f',
    blueGlow: 'rgba(59, 130, 246, 0.1)',
    cyan: '#06b6d4',
    purple: '#a78bfa',
    purpleDim: '#3b1f6e',
    yellow: '#eab308'
  },

  spacing: {
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '20px',
    '2xl': '24px',
    '3xl': '32px',
    '4xl': '40px',
    '5xl': '56px',
    '6xl': '80px'
  },

  borderRadius: {
    sm: '3px',
    base: '4px',
    md: '6px',
    lg: '7px',
    xl: '10px',
    '2xl': '12px',
    full: '50%'
  },

  shadows: {
    card: '0 1px 3px rgba(0,0,0,0.3)',
    glow: {
      red: '0 0 8px rgba(239, 68, 68, 0.15)',
      green: '0 0 8px rgba(34, 197, 94, 0.1)',
      blue: '0 0 8px rgba(59, 130, 246, 0.1)'
    }
  },

  transitions: {
    fast: '0.15s',
    base: '0.2s',
    all: 'all 0.2s'
  },

  components: {
    tab: {
      padding: '10px 20px',
      borderRadius: '7px',
      fontSize: '12px',
      fontWeight: 500,
      fontFamily: "'JetBrains Mono', monospace",
      colors: {
        default: {
          bg: 'transparent',
          text: '#8892a8'
        },
        hover: {
          bg: '#1a1e28',
          text: '#e2e8f0'
        },
        active: {
          bg: '#222835',
          text: '#e2e8f0',
          shadow: '0 1px 3px rgba(0,0,0,0.3)'
        }
      }
    },

    component: {
      padding: '7px 12px',
      borderRadius: '6px',
      fontSize: '11px',
      fontFamily: "'JetBrains Mono', monospace",
      colors: {
        default: {
          bg: '#1a1e28',
          border: '#2a3040',
          text: '#8892a8'
        },
        hover: {
          bg: '#222835',
          border: '#3a4560',
          text: '#e2e8f0'
        }
      }
    },

    badge: {
      padding: '2px 8px',
      borderRadius: '4px',
      fontSize: '9px',
      fontWeight: 500,
      letterSpacing: '0.5px',
      variants: {
        good: {
          bg: '#14532d',
          text: '#22c55e'
        },
        warn: {
          bg: '#78350f',
          text: '#f59e0b'
        },
        neutral: {
          bg: '#1e3a5f',
          text: '#3b82f6'
        },
        best: {
          bg: '#3b1f6e',
          text: '#a78bfa'
        }
      }
    },

    status: {
      padding: '1px 6px',
      borderRadius: '3px',
      fontSize: '9px',
      fontWeight: 600,
      letterSpacing: '0.5px',
      fontFamily: "'JetBrains Mono', monospace",
      variants: {
        on: {
          bg: '#14532d',
          text: '#22c55e'
        },
        off: {
          bg: '#2a3040',
          text: '#5a6478'
        },
        limited: {
          bg: '#78350f',
          text: '#f59e0b'
        },
        blocked: {
          bg: '#7f1d1d',
          text: '#ef4444'
        }
      }
    },

    zoneLabel: {
      fontSize: '10px',
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '1.5px',
      fontFamily: "'JetBrains Mono', monospace",
      variants: {
        external: {
          color: '#ef4444',
          dotColor: '#ef4444',
          dotGlow: '0 0 8px rgba(239, 68, 68, 0.15)',
          badgeBg: '#7f1d1d',
          badgeText: '#ef4444'
        },
        host: {
          color: '#3b82f6',
          dotColor: '#3b82f6',
          dotGlow: '0 0 8px rgba(59, 130, 246, 0.1)',
          badgeBg: '#1e3a5f',
          badgeText: '#3b82f6'
        },
        sandbox: {
          color: '#22c55e',
          dotColor: '#22c55e',
          dotGlow: '0 0 8px rgba(34, 197, 94, 0.1)',
          badgeBg: '#14532d',
          badgeText: '#22c55e'
        }
      }
    },

    card: {
      padding: '24px 28px',
      borderRadius: '12px',
      border: '1px solid #2a3040',
      bg: '#12151c'
    },

    sectionHeader: {
      fontSize: '16px',
      fontWeight: 700,
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: '-0.3px',
      color: '#e2e8f0',
      marginBottom: '16px'
    }
  },

  layout: {
    container: {
      maxWidth: '1280px',
      padding: '40px 32px 80px'
    },
    grid: {
      gap: '2px',
      gapMd: '8px',
      gapLg: '12px'
    }
  },

  iconSizes: {
    dot: '8px',
    xs: '12px',
    sm: '14px',
    base: '16px',
    lg: '20px',
    xl: '24px'
  }
};

// ═══════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════

export function generateCSSVariables(): string {
  return `
    :root {
      /* Colors */
      --bg: ${designSystem.colors.bg};
      --surface: ${designSystem.colors.surface};
      --surface-2: ${designSystem.colors.surface2};
      --surface-3: ${designSystem.colors.surface3};
      --border: ${designSystem.colors.border};
      --border-accent: ${designSystem.colors.borderAccent};
      --text: ${designSystem.colors.text};
      --text-dim: ${designSystem.colors.textDim};
      --text-muted: ${designSystem.colors.textMuted};
      --red: ${designSystem.colors.red};
      --red-dim: ${designSystem.colors.redDim};
      --red-glow: ${designSystem.colors.redGlow};
      --orange: ${designSystem.colors.orange};
      --orange-dim: ${designSystem.colors.orangeDim};
      --green: ${designSystem.colors.green};
      --green-dim: ${designSystem.colors.greenDim};
      --green-glow: ${designSystem.colors.greenGlow};
      --blue: ${designSystem.colors.blue};
      --blue-dim: ${designSystem.colors.blueDim};
      --blue-glow: ${designSystem.colors.blueGlow};
      --cyan: ${designSystem.colors.cyan};
      --purple: ${designSystem.colors.purple};
      --purple-dim: ${designSystem.colors.purpleDim};
      --yellow: ${designSystem.colors.yellow};

      /* Typography */
      --font-primary: ${designSystem.fonts.primary};
      --font-mono: ${designSystem.fonts.mono};

      /* Spacing */
      --space-xs: ${designSystem.spacing.xs};
      --space-sm: ${designSystem.spacing.sm};
      --space-md: ${designSystem.spacing.md};
      --space-lg: ${designSystem.spacing.lg};
      --space-xl: ${designSystem.spacing.xl};
      --space-2xl: ${designSystem.spacing['2xl']};
      --space-3xl: ${designSystem.spacing['3xl']};
      --space-4xl: ${designSystem.spacing['4xl']};

      /* Border Radius */
      --radius-sm: ${designSystem.borderRadius.sm};
      --radius-base: ${designSystem.borderRadius.base};
      --radius-md: ${designSystem.borderRadius.md};
      --radius-lg: ${designSystem.borderRadius.lg};
      --radius-xl: ${designSystem.borderRadius.xl};
      --radius-2xl: ${designSystem.borderRadius['2xl']};

      /* Transitions */
      --transition-fast: ${designSystem.transitions.fast};
      --transition-base: ${designSystem.transitions.base};
    }
  `.trim();
}

export function getColor(colorName: keyof ColorPalette): string {
  return designSystem.colors[colorName] || designSystem.colors.text;
}

export function getSpacing(size: keyof Spacing): string {
  return designSystem.spacing[size] || designSystem.spacing.md;
}

export function getComponentStyle<T extends keyof Components>(
  component: T,
  variant?: string
): Components[T] {
  const comp = designSystem.components[component];
  return comp;
}

export default designSystem;
