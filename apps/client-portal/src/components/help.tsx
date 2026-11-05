import { helpBlocks } from "@qcs/types";

/** Renders a help article's plain text (paragraphs and bullet lists). */
export function HelpBody({ body }: { body: string }) {
  return <>{helpBlocks(body).map((b, i) => (b.kind === "p" ? <p key={i}>{b.text}</p> : <ul key={i}>{b.items.map((x, j) => <li key={j}>{x}</li>)}</ul>))}</>;
}
