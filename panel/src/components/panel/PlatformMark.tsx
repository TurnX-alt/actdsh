interface MarkProps {
  className?: string;
}

export function MicrosoftMark({ className }: MarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      className={className}
      aria-hidden
    >
      <path d="M11.49 2H2v9.492h9.492V2h-.002z" />
      <path d="M22 2h-9.492v9.492H22V2z" />
      <path d="M11.49 12.508H2V22h9.492v-9.492h-.002z" />
      <path d="M22 12.508h-9.492V22H22v-9.492z" />
    </svg>
  );
}

export function AppleMark({ className }: MarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      className={className}
      aria-hidden
    >
      <path d="M11.932 6.908c.95 0 2.727-1.291 4.595-1.1.782.032 2.976.316 4.388 2.38-.113.069-2.622 1.528-2.593 4.565.034 3.617 3.166 4.828 3.221 4.85-.029.086-.506 1.723-1.658 3.416-1.002 1.463-2.039 2.919-3.675 2.95-1.606.03-2.125-.955-3.96-.955s-2.409.923-3.931.984c-1.581.06-2.78-1.58-3.79-3.037-2.065-2.98-3.64-8.422-1.527-12.087 1.051-1.824 2.93-2.98 4.969-3.009 1.549-.032 3.011 1.043 3.96 1.043zM16.552 0c.153 1.407-.411 2.817-1.251 3.833-.837 1.013-2.214 1.804-3.555 1.7-.185-1.378.495-2.814 1.27-3.712C13.883.805 15.346.05 16.553 0z" />
    </svg>
  );
}