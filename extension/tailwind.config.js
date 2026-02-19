/** @type {import('tailwindcss').Config} */
export default {
    content: ['./src/**/*.{ts,tsx,html}'],
    theme: {
        extend: {
            colors: {
                astra: {
                    bg: '#0f0f1a',
                    surface: '#1a1a2e',
                    border: '#2a2a4a',
                    primary: '#6366f1',
                    'primary-hover': '#818cf8',
                    accent: '#a78bfa',
                    text: '#e2e8f0',
                    'text-muted': '#94a3b8',
                    success: '#34d399',
                    error: '#f87171',
                    warning: '#fbbf24',
                },
            },
            fontFamily: {
                sans: ['Inter', 'system-ui', 'sans-serif'],
                mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
            },
            animation: {
                'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
                'slide-up': 'slide-up 0.3s ease-out',
                'fade-in': 'fade-in 0.2s ease-out',
            },
            keyframes: {
                'pulse-glow': {
                    '0%, 100%': { boxShadow: '0 0 5px rgba(99, 102, 241, 0.3)' },
                    '50%': { boxShadow: '0 0 20px rgba(99, 102, 241, 0.6)' },
                },
                'slide-up': {
                    '0%': { opacity: '0', transform: 'translateY(10px)' },
                    '100%': { opacity: '1', transform: 'translateY(0)' },
                },
                'fade-in': {
                    '0%': { opacity: '0' },
                    '100%': { opacity: '1' },
                },
            },
        },
    },
    plugins: [],
};
