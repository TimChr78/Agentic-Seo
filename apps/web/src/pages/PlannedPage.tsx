import { ArrowLeft } from 'lucide-react';
import { ButtonLink } from '../app/links';
import { useCrumbs } from '../app/page';
import { PLANNED } from '../app/planned';
import { Card, EmptyState, PageHeader } from '../ui';

/**
 * A destination Phase 0 does not build yet. It still has a real page: the canonical h1, what the
 * screen will hold, and the phase that delivers it. No sample rows or lorem ipsum stand in for it.
 */
export function PlannedPage({ path }: { path: string }) {
  const planned = PLANNED[path];
  useCrumbs([{ label: planned?.title ?? 'Not found' }]);

  if (!planned) return <NotFound />;

  return (
    <>
      <PageHeader title={planned.title} description={planned.description} />
      <Card>
        <EmptyState
          title={`${planned.title} arrives in ${planned.phase}`}
          action={
            <ButtonLink to="/" variant="secondary" icon={<ArrowLeft size={14} />}>
              Back to Home
            </ButtonLink>
          }
        >
          {planned.body}
        </EmptyState>
      </Card>
    </>
  );
}

export function NotFound() {
  useCrumbs([{ label: 'Not found' }]);
  return (
    <>
      <PageHeader title="Page not found" description="This address is not part of the admin UI." />
      <Card>
        <EmptyState
          title="This page does not exist"
          action={
            <ButtonLink to="/" variant="secondary" icon={<ArrowLeft size={14} />}>
              Back to Home
            </ButtonLink>
          }
        >
          Check the address, or use search to open a page that does exist.
        </EmptyState>
      </Card>
    </>
  );
}
