import { cn } from '@renderer/lib/utils';

type LogoProps = {
  className?: string;
};

/**
 * double0 logo mark - "00" set in JetBrains Mono (the brand's dotted zeros).
 * Mirrors Logo/Mark in the design system. Drawn as a single evenodd path so it
 * stays crisp at any size, is font-independent, and recolors with the accent
 * (`fill-primary`) the way the rest of the primary-green chrome does.
 */
export function Logo({ className }: LogoProps) {
  return (
    <svg
      width="30.5"
      height="24"
      viewBox="0 0 56 44"
      className={cn('fill-primary', className)}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10 0H14A10 10 0 0 1 24 10V34A10 10 0 0 1 14 44H10A10 10 0 0 1 0 34V10A10 10 0 0 1 10 0ZM10 7H14A3 3 0 0 1 17 10V34A3 3 0 0 1 14 37H10A3 3 0 0 1 7 34V10A3 3 0 0 1 10 7ZM8.8 22A3.2 3.2 0 1 0 15.2 22A3.2 3.2 0 1 0 8.8 22ZM42 0H46A10 10 0 0 1 56 10V34A10 10 0 0 1 46 44H42A10 10 0 0 1 32 34V10A10 10 0 0 1 42 0ZM42 7H46A3 3 0 0 1 49 10V34A3 3 0 0 1 46 37H42A3 3 0 0 1 39 34V10A3 3 0 0 1 42 7ZM40.8 22A3.2 3.2 0 1 0 47.2 22A3.2 3.2 0 1 0 40.8 22Z"
      />
    </svg>
  );
}
