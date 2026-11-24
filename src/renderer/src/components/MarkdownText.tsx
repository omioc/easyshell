import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Agent output, rendered as markdown.
 *
 * It is built for a streaming transcript: every chunk that lands re-renders the
 * whole text, so there is no incremental parser state that can drift out of
 * sync with what arrived, and a code fence that has not been closed yet simply
 * renders as a code block that keeps growing. Raw HTML is never passed through —
 * the agent writes prose, not markup — so there is nothing to sanitise.
 *
 * Links open in the system browser: the host's window-open handler sends them
 * out and denies the popup, so the app itself never navigates away.
 */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="agent-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
          table: ({ node, ...props }) => (
            <div className="agent-md-table">
              <table {...props} />
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
