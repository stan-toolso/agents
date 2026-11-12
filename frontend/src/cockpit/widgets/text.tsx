import Markdown from '../../components/Markdown';
import type { WidgetProps } from '../registry';

/** Bloc de texte libre (Markdown) : consigne, liens utiles, légende. */
export function TextWidget({ block, params }: WidgetProps) {
  const text = typeof params.markdown === 'string' ? params.markdown : '';
  return (
    <section className="dash-section">
      {block.title && (
        <h2 className="dash-section-title">
          <span>{block.title}</span>
        </h2>
      )}
      <div className="task-dash-card">{text.trim() ? <Markdown text={text} base="ck-md" /> : <div className="hint">Texte vide : réglez le bloc pour écrire quelque chose.</div>}</div>
    </section>
  );
}
