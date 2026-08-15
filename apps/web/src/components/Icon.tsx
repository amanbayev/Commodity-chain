export type IconName =
  'assets' | 'create' | 'documents' | 'market' | 'menu' | 'redemption' | 'terminal';

const paths: Record<IconName, string> = {
  assets: 'M4 7h16v12H4zM7 4h10v3M8 12h8M8 16h5',
  create: 'M12 3v18M3 12h18M5 5h14v14H5z',
  documents: 'M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6',
  market: 'M4 19V9M10 19V5M16 19v-7M22 19H2M3 14l6-5 5 3 7-8',
  menu: 'M4 7h16M4 12h16M4 17h16',
  redemption: 'M20 7v5h-5M4 17v-5h5M6.1 8a7 7 0 0 1 11.3-2.1L20 9M4 15l2.6 3.1A7 7 0 0 0 17.9 16',
  terminal: 'M3 4h18v16H3zM7 15l3-3 3 2 4-5',
};

export interface IconProps {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 22 }: IconProps) {
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <path
        d={paths[name]}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}
