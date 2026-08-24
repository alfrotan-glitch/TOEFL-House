/**
 * Placement UI camelCase contract.
 *
 * The frontend API client normalizes backend JSON to camelCase. PlacementTestModal
 * must therefore read camelCase attempt/snapshot/result fields. A snake_case read
 * path leaves the section cards visible but disconnects them from the active
 * editor, so operators cannot actually run Placement V1 in the live UI.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
vi.mock('lucide-react', () => {
  const icon = (name: string) => () => React.createElement('span', { 'data-icon': name });
  return {
    AlertTriangle: icon('AlertTriangle'),
    BookOpen: icon('BookOpen'),
    CheckCircle2: icon('CheckCircle2'),
    Clock3: icon('Clock3'),
    FileText: icon('FileText'),
    Loader2: icon('Loader2'),
    MessageSquareText: icon('MessageSquareText'),
    Mic: icon('Mic'),
    Pause: icon('Pause'),
    Play: icon('Play'),
    Save: icon('Save'),
    ShieldCheck: icon('ShieldCheck'),
    Timer: icon('Timer'),
    X: icon('X'),
  };
});

vi.mock('../../../../../src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
  },
}));

import PlacementTestModal from '../../../../../src/components/visitors/PlacementTestModal';
import { ServerStateFreshnessProvider } from '../../../../../src/state/serverStateFreshness';
import { api } from '../../../../../src/api/client';

const mockedApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
};

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = dom.window.document.createElement('div') as unknown as HTMLDivElement;
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
  mockedApi.get.mockReset();
  mockedApi.post.mockReset();
  mockedApi.put.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactElement) {
  act(() => root.render(node));
}

function clickButton(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find((entry) => (entry.textContent || '').includes(label)) as HTMLButtonElement | undefined;
  if (!button) throw new Error(`Button not found: ${label}`);
  act(() => button.click());
}

async function waitFor(predicate: () => boolean, timeout = 2000, interval = 20) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, interval)); });
    if (predicate()) return;
  }
  throw new Error('Timed out waiting for placement modal state.');
}

describe('PlacementTestModal', () => {
  it('renders the active DIGITAL section editor from camelCase API fields', async () => {
    mockedApi.get.mockResolvedValue({
      profile: {
        configured: true,
        enabled: true,
        required: true,
        requirementMode: 'required',
        policyVersion: 1,
        programName: 'E2E Program',
        versionLabel: 'E2E V1',
        instructions: 'Run Placement V1.',
        components: [
          { key: 'grammar', type: 'grammar', label: 'Grammar', required: true, weight: 25, maxScore: 30, timeLimitSeconds: 300, instructions: 'Grammar section' },
        ],
        levels: [],
        allowRetake: true,
        passScore: 60,
        scoringModel: 'canonical',
        deliveryModes: ['DIGITAL', 'PHYSICAL'],
      },
      requirement: { mode: 'required', decision: 'REQUIRED' },
      admissionRequired: false,
      linkedStudentId: 'stu_1',
      current: {
        id: 'pat_1',
        attemptNumber: 1,
        status: 'in_progress',
        percentage: null,
        recommendationText: null,
        expiresAt: null,
        deliveryMode: 'DIGITAL',
        snapshot: {
          deliveryMode: 'DIGITAL',
          components: [
            { key: 'grammar', type: 'grammar', label: 'Grammar', required: true, weight: 25, maxScore: 30, timeLimitSeconds: 300, instructions: 'Grammar section' },
          ],
          tests: [
            {
              id: 'snapshot:grammar',
              componentKey: 'grammar',
              title: 'Grammar Digital',
              testType: 'grammar',
              instructions: 'Choose the correct answer.',
              durationSeconds: 300,
              sections: [],
              questions: [
                {
                  id: 'q1',
                  questionKey: 'grammar_1',
                  qtype: 'mcq',
                  prompt: 'Choose A',
                  optionsJson: JSON.stringify([{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }]),
                  points: 1,
                },
              ],
            },
          ],
        },
        results: [
          {
            componentKey: 'grammar',
            componentType: 'grammar',
            label: 'Grammar',
            status: 'pending',
            score: null,
            maxScore: 30,
            weight: 25,
            selectedLevelId: null,
            notes: null,
            resultText: null,
            payloadJson: null,
            startedAt: null,
            deadlineAt: null,
            elapsedSeconds: null,
            timeoutFlag: 0,
            rawScore: null,
            percentage: null,
          },
        ],
        responses: [],
      },
    });

    render(
      React.createElement(ServerStateFreshnessProvider, {
        value: { invalidate: () => undefined, datasetVersion: {} },
        children: React.createElement(PlacementTestModal, {
          visitor: { id: 'vis_1', fullName: 'Camel Case Candidate' } as any,
          onClose: () => undefined,
          onCompleted: async () => undefined,
          triggerToast: () => undefined,
        }),
      }),
    );

    await waitFor(() => (container.textContent || '').includes('Start timer'));

    const text = container.textContent || '';
    expect(text).toContain('Grammar section');
    expect(text).toContain('Choose A');
    expect(text).toContain('Submit responses');
  });

  it('keeps the selected component active across workspace refreshes after starting a timer', async () => {
    mockedApi.get
      .mockResolvedValueOnce({
        profile: {
          configured: true,
          enabled: true,
          required: true,
          requirementMode: 'required',
          policyVersion: 1,
          programName: 'E2E Program',
          versionLabel: 'E2E V1',
          instructions: 'Run Placement V1.',
          components: [
            { key: 'grammar', type: 'grammar', label: 'Grammar', required: true, weight: 25, maxScore: 30, timeLimitSeconds: 300, instructions: 'Grammar section' },
            { key: 'reading', type: 'reading', label: 'Reading', required: true, weight: 16.67, maxScore: 20, timeLimitSeconds: 300, instructions: 'Reading section' },
          ],
          levels: [],
          allowRetake: true,
          passScore: 60,
          scoringModel: 'canonical',
          deliveryModes: ['DIGITAL', 'PHYSICAL'],
        },
        requirement: { mode: 'required', decision: 'REQUIRED' },
        admissionRequired: false,
        linkedStudentId: 'stu_1',
        current: {
          id: 'pat_1',
          attemptNumber: 1,
          status: 'in_progress',
          deliveryMode: 'DIGITAL',
          snapshot: {
            deliveryMode: 'DIGITAL',
            components: [
              { key: 'grammar', type: 'grammar', label: 'Grammar', required: true, weight: 25, maxScore: 30, timeLimitSeconds: 300, instructions: 'Grammar section' },
              { key: 'reading', type: 'reading', label: 'Reading', required: true, weight: 16.67, maxScore: 20, timeLimitSeconds: 300, instructions: 'Reading section' },
            ],
            tests: [
              {
                id: 'snapshot:grammar',
                componentKey: 'grammar',
                title: 'Grammar Digital',
                testType: 'grammar',
                instructions: 'Grammar instructions',
                durationSeconds: 300,
                sections: [],
                questions: [{ id: 'g1', questionKey: 'grammar_1', qtype: 'mcq', prompt: 'Choose A', optionsJson: JSON.stringify([{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }]), points: 1 }],
              },
              {
                id: 'snapshot:reading',
                componentKey: 'reading',
                title: 'Reading Digital',
                testType: 'reading',
                instructions: 'Reading instructions',
                durationSeconds: 300,
                sections: [],
                questions: [{ id: 'r1', questionKey: 'reading_1', qtype: 'mcq', prompt: 'Read and choose A', optionsJson: JSON.stringify([{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }]), points: 1 }],
              },
            ],
          },
          results: [
            { componentKey: 'grammar', componentType: 'grammar', label: 'Grammar', status: 'completed', score: 30, maxScore: 30, weight: 25, selectedLevelId: null, notes: null, resultText: null, payloadJson: null, startedAt: '2026-08-24 00:00:00', deadlineAt: '2026-08-24 00:05:00', elapsedSeconds: 10, timeoutFlag: 0, rawScore: 30, percentage: 100 },
            { componentKey: 'reading', componentType: 'reading', label: 'Reading', status: 'pending', score: null, maxScore: 20, weight: 16.67, selectedLevelId: null, notes: null, resultText: null, payloadJson: null, startedAt: null, deadlineAt: null, elapsedSeconds: null, timeoutFlag: 0, rawScore: null, percentage: null },
          ],
          responses: [],
        },
      })
      .mockResolvedValueOnce({
        profile: {
          configured: true,
          enabled: true,
          required: true,
          requirementMode: 'required',
          policyVersion: 1,
          programName: 'E2E Program',
          versionLabel: 'E2E V1',
          instructions: 'Run Placement V1.',
          components: [
            { key: 'grammar', type: 'grammar', label: 'Grammar', required: true, weight: 25, maxScore: 30, timeLimitSeconds: 300, instructions: 'Grammar section' },
            { key: 'reading', type: 'reading', label: 'Reading', required: true, weight: 16.67, maxScore: 20, timeLimitSeconds: 300, instructions: 'Reading section' },
          ],
          levels: [],
          allowRetake: true,
          passScore: 60,
          scoringModel: 'canonical',
          deliveryModes: ['DIGITAL', 'PHYSICAL'],
        },
        requirement: { mode: 'required', decision: 'REQUIRED' },
        admissionRequired: false,
        linkedStudentId: 'stu_1',
        current: {
          id: 'pat_1',
          attemptNumber: 1,
          status: 'in_progress',
          deliveryMode: 'DIGITAL',
          snapshot: {
            deliveryMode: 'DIGITAL',
            components: [
              { key: 'grammar', type: 'grammar', label: 'Grammar', required: true, weight: 25, maxScore: 30, timeLimitSeconds: 300, instructions: 'Grammar section' },
              { key: 'reading', type: 'reading', label: 'Reading', required: true, weight: 16.67, maxScore: 20, timeLimitSeconds: 300, instructions: 'Reading section' },
            ],
            tests: [
              {
                id: 'snapshot:grammar',
                componentKey: 'grammar',
                title: 'Grammar Digital',
                testType: 'grammar',
                instructions: 'Grammar instructions',
                durationSeconds: 300,
                sections: [],
                questions: [{ id: 'g1', questionKey: 'grammar_1', qtype: 'mcq', prompt: 'Choose A', optionsJson: JSON.stringify([{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }]), points: 1 }],
              },
              {
                id: 'snapshot:reading',
                componentKey: 'reading',
                title: 'Reading Digital',
                testType: 'reading',
                instructions: 'Reading instructions',
                durationSeconds: 300,
                sections: [],
                questions: [{ id: 'r1', questionKey: 'reading_1', qtype: 'mcq', prompt: 'Read and choose A', optionsJson: JSON.stringify([{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }]), points: 1 }],
              },
            ],
          },
          results: [
            { componentKey: 'grammar', componentType: 'grammar', label: 'Grammar', status: 'completed', score: 30, maxScore: 30, weight: 25, selectedLevelId: null, notes: null, resultText: null, payloadJson: null, startedAt: '2026-08-24 00:00:00', deadlineAt: '2026-08-24 00:05:00', elapsedSeconds: 10, timeoutFlag: 0, rawScore: 30, percentage: 100 },
            { componentKey: 'reading', componentType: 'reading', label: 'Reading', status: 'in_progress', score: null, maxScore: 20, weight: 16.67, selectedLevelId: null, notes: null, resultText: null, payloadJson: null, startedAt: '2026-08-24 00:01:00', deadlineAt: '2026-08-24 00:06:00', elapsedSeconds: 0, timeoutFlag: 0, rawScore: null, percentage: null },
          ],
          responses: [],
        },
      });
    mockedApi.put.mockResolvedValue({});

    render(
      React.createElement(ServerStateFreshnessProvider, {
        value: { invalidate: () => undefined, datasetVersion: {} },
        children: React.createElement(PlacementTestModal, {
          visitor: { id: 'vis_1', fullName: 'Camel Case Candidate' } as any,
          onClose: () => undefined,
          onCompleted: async () => undefined,
          triggerToast: () => undefined,
        }),
      }),
    );

    await waitFor(() => (container.textContent || '').includes('Grammar section'));
    clickButton('Reading');
    await waitFor(() => (container.textContent || '').includes('Reading section'));
    clickButton('Start timer');
    await waitFor(() => mockedApi.put.mock.calls.length === 1);
    await waitFor(() => (container.textContent || '').includes('Reading section'));

    expect(mockedApi.put).toHaveBeenCalledWith('/placement/visitors/vis_1/placement/attempts/pat_1/tests/reading/start', {});
    expect(container.textContent || '').toContain('Reading section');
  });
});
