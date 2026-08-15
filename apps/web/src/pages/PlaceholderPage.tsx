import { Card } from '../components/Card/Card.js';
import { PageHeader } from '../components/PageHeader/PageHeader.js';
import styles from './PlaceholderPage.module.css';

export interface PlaceholderPageProps {
  subtitle: string;
  title: string;
}

export function PlaceholderPage({ subtitle, title }: PlaceholderPageProps) {
  return (
    <>
      <PageHeader eyebrow="Commodity Chain" subtitle={subtitle} title={title} />
      <Card>
        <div className={styles.placeholder}>
          <span aria-hidden="true">◇</span>
          <h2>Раздел в разработке</h2>
          <p>Фундамент интерфейса готов. Бизнес-сценарий будет реализован отдельной задачей.</p>
        </div>
      </Card>
    </>
  );
}
