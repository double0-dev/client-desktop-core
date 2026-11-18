import { CircleAlert, FileCode, FilePlus, FileX, type LucideIcon } from 'lucide-react';

// Status-letter presentation shared by the commit panel and the diff toolbar.
// Lives in lib/ (not a component file) so react-refresh keeps fast refresh on
// the components that use it.

/** Icon + tint for a file's status letter. */
export function fileGlyph(letter: string): { icon: LucideIcon; iconClass: string } {
  switch (letter) {
    case 'A':
      return { icon: FilePlus, iconClass: 'text-success' };
    case 'D':
      return { icon: FileX, iconClass: 'text-destructive' };
    case '!':
      return { icon: CircleAlert, iconClass: 'text-warning' };
    default:
      return { icon: FileCode, iconClass: 'text-[#60a5fa]' };
  }
}

/** Text tint for a status letter. */
export function letterClass(letter: string): string {
  switch (letter) {
    case 'A':
      return 'text-success';
    case 'D':
      return 'text-destructive';
    case '!':
      return 'text-warning';
    case 'M':
      return 'text-warning';
    default:
      return 'text-[#60a5fa]';
  }
}
