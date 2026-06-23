import type { Metadata, Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  title: 'Rolling Metric Chart · FanGraphs Tools',
  description: 'Compare MLB player rolling averages across the season',
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚾</text></svg>",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <footer style={{ textAlign: 'center', padding: '20px', fontSize: '0.75rem', color: '#64748b' }}>
          Data: <a href="https://www.fangraphs.com" target="_blank" rel="noopener" style={{ color: '#94a3b8', textDecoration: 'underline' }}>FanGraphs</a>
        </footer>
      </body>
    </html>
  );
}
