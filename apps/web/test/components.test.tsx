import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetailPage } from '../src/ui/DetailPage';
import { DiffView } from '../src/ui/diff';
import { Field, Input } from '../src/ui/form';
import { ListPage } from '../src/ui/ListPage';
import { Menu } from '../src/ui/menu';
import { useConfirm } from '../src/ui/overlay';
import {
  ChartSkeleton,
  EditorSkeleton,
  KpiSkeleton,
  ListSkeleton,
  LoadingBlock,
  SKELETON_DELAY_MS,
  SKELETON_GEOMETRY,
  Skeleton,
} from '../src/ui/Skeleton';
import { Tabs } from '../src/ui/tabs';

afterEach(cleanup);

describe('ui components', () => {
  it('Field wires its label, hint and error to the control', () => {
    render(
      <Field label="Primary domain" hint="The host people search for." error="Enter a domain.">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText('Primary domain');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = input
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['Enter a domain.', 'The host people search for.']);
  });

  it('Tabs move with the arrow keys (WAI-ARIA)', async () => {
    function TestTabs() {
      const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
      return (
        <Tabs
          label="Sections"
          value={value}
          onChange={setValue}
          items={[
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
            { key: 'c', label: 'C' },
          ]}
        >
          {value}
        </Tabs>
      );
    }
    render(<TestTabs />);
    screen.getByRole('tab', { name: 'A' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'B' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tabpanel').textContent).toBe('c');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'A' })).toBe(document.activeElement);
  });

  it('a destructive confirm with the object name stays disabled until the name is typed', async () => {
    let answer: boolean | undefined;
    function Confirm() {
      const [dialog, ask] = useConfirm();
      return (
        <>
          <button
            type="button"
            onClick={async () =>
              (answer = await ask({
                title: 'Delete “martechsignal.com”?',
                confirmLabel: 'Delete site',
                destructive: true,
                typeToConfirm: 'martechsignal.com',
              }))
            }
          >
            open
          </button>
          {dialog}
        </>
      );
    }
    render(<Confirm />);
    await userEvent.click(screen.getByText('open'));
    const confirm = screen.getByRole('button', { name: 'Delete site' });
    expect(confirm).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText(/to confirm/), 'martechsignal.com');
    expect(confirm).toHaveProperty('disabled', false);
    await userEvent.click(confirm);
    expect(answer).toBe(true);
  });

  it('Escape cancels a confirm', async () => {
    let answer: boolean | undefined;
    function Confirm() {
      const [dialog, ask] = useConfirm();
      return (
        <>
          <button type="button" onClick={async () => (answer = await ask({ title: 'Delete?', confirmLabel: 'Delete' }))}>
            open
          </button>
          {dialog}
        </>
      );
    }
    render(<Confirm />);
    await userEvent.click(screen.getByText('open'));
    await userEvent.keyboard('{Escape}');
    expect(answer).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Menu opens with ArrowDown, moves with arrows and selects with Enter', async () => {
    const picked: string[] = [];
    render(
      <Menu
        label="More"
        items={[
          { label: 'Edit', onSelect: () => picked.push('edit') },
          'separator',
          { label: 'Delete', destructive: true, onSelect: () => picked.push('delete') },
        ]}
        trigger={(props) => (
          <button type="button" {...props}>
            More
          </button>
        )}
      />,
    );
    screen.getByRole('button', { name: 'More' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBe(document.activeElement);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(picked).toEqual(['delete']);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('DiffView labels changes in words, not colour alone', () => {
    render(
      <DiffView
        from={1}
        to={2}
        changes={[
          { path: 'title', kind: 'changed', before: 'Old', after: 'New' },
          { path: 'description', kind: 'added', after: 'Hi' },
        ]}
      />,
    );
    expect(screen.getByText('Changed')).toBeTruthy();
    expect(screen.getByText('Added')).toBeTruthy();
    expect(screen.getByText(/v1 \(live\) → v2/)).toBeTruthy();
    expect(screen.getAllByText(/Before:|After:/).length).toBe(3);
    act(() => fireEvent.click(document.body));
  });
});

describe('reserved loading geometry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the list geometry the ready template uses', () => {
    render(<ListSkeleton label="Loading issues" />);
    const region = screen.getByRole('status', { name: 'Loading issues' });
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(region.getAttribute('data-geometry')).toBe('list');
    const table = region.querySelector('[data-skeleton-list="table"]')!;
    expect(table.querySelector('.h-9')).toBeTruthy();
    expect(table.querySelectorAll('.h-12')).toHaveLength(5);
    const cards = region.querySelector('[data-skeleton-list="cards"]')!;
    expect(cards.querySelectorAll('.min-h-\\[88px\\]')).toHaveLength(5);
  });

  it('renders the KPI and chart slots with their final dimensions', () => {
    render(<KpiSkeleton label="Loading clicks" />);
    const kpi = screen.getByRole('status', { name: 'Loading clicks' });
    expect(kpi.style.minHeight).toBe('204px');
    cleanup();
    render(<ChartSkeleton label="Loading performance" />);
    const chart = document.querySelector('[data-skeleton-shape="chart"]')!;
    expect(chart.className).toContain('h-[200px]');
    expect(chart.className).toContain('md:h-[240px]');
  });

  it('reserves the space immediately and reveals shapes only after 150 ms', () => {
    vi.useFakeTimers();
    render(<ListSkeleton label="Loading sites" />);
    const region = screen.getByRole('status', { name: 'Loading sites' });
    expect(region.getAttribute('data-skeleton-visible')).toBe('false');
    expect(region.querySelectorAll('.h-12')).toHaveLength(5);
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS - 1));
    expect(region.getAttribute('data-skeleton-visible')).toBe('false');
    act(() => vi.advanceTimersByTime(1));
    expect(region.getAttribute('data-skeleton-visible')).toBe('true');
  });

  it('keeps the generic adapter labelled and geometry-aware', () => {
    render(<LoadingBlock lines={2} label="Loading reports" geometry="chart" delay={0} />);
    const region = screen.getByRole('status', { name: 'Loading reports' });
    expect(region.getAttribute('data-geometry')).toBe('chart');
    expect(region.querySelector('[data-skeleton-shape="chart"]')).toBeTruthy();
  });

  it('fills its reserved frame only when the caller asks for fill', () => {
    render(
      <div style={{ height: 504 }}>
        <EditorSkeleton label="Loading the editor" fill />
      </div>,
    );
    const region = screen.getByRole('status', { name: 'Loading the editor' });
    expect(region.className).toContain('h-full');
    expect(region.getAttribute('data-fill')).toBe('true');
    expect((region.querySelector('[data-skeleton-shape="editor"]') as HTMLElement).style.height).toBe('100%');
    cleanup();
    render(<EditorSkeleton label="Loading the editor" />);
    const plain = screen.getByRole('status', { name: 'Loading the editor' });
    expect(plain.className).not.toContain('h-full');
    expect(plain.getAttribute('data-fill')).toBeNull();
    expect((plain.querySelector('[data-skeleton-shape="editor"]') as HTMLElement).style.height).toBe('');
  });

  it('never renders an animated shape', () => {
    render(<Skeleton shape="card" />);
    const shape = document.querySelector('[data-skeleton-shape="card"]')!;
    expect(shape.className).not.toMatch(/animate-|shimmer/);
  });
});

describe('shared templates reserve the same geometry', () => {
  it('ListPage uses the shared list skeleton when the caller has no custom slots', () => {
    render(<ListPage title="Issues" description="What an audit found." state="loading" desktopTable={null} mobileList={null} />);
    const region = screen.getByRole('status', { name: 'Loading issues' });
    expect(region.getAttribute('data-geometry')).toBe('list');
    expect(region.querySelector('[data-skeleton-list="table"]')).toBeTruthy();
    expect(region.querySelector('[data-skeleton-list="cards"]')).toBeTruthy();
  });

  it('DetailPage uses the shared detail skeleton when the caller has no custom slots', () => {
    render(
      <DetailPage
        title="Issue"
        kind="Issue"
        metadata={null}
        consequence={null}
        tabs={[]}
        activeTab=""
        onTabChange={() => {}}
        state="loading"
      />,
    );
    const region = screen.getByRole('status', { name: 'Loading issue' });
    expect(region.getAttribute('data-geometry')).toBe('detail');
    expect(region.querySelector('[data-skeleton-detail="header"]')).toBeTruthy();
    expect(region.querySelector('[data-skeleton-detail="panel"]')).toBeTruthy();
  });

  it('keeps the design dimensions', () => {
    expect(SKELETON_GEOMETRY.list.header).toBe(36);
    expect(SKELETON_GEOMETRY.list.row).toBe(48);
    expect(SKELETON_GEOMETRY.kpi.minHeight).toBe(204);
    expect(SKELETON_GEOMETRY.chart.plot).toBe(200);
    expect(SKELETON_GEOMETRY.chart.plotDesktop).toBe(240);
    expect(SKELETON_GEOMETRY.editor.mobile).toBe(420);
    expect(SKELETON_GEOMETRY.editor.desktop).toBe(560);
  });
});
