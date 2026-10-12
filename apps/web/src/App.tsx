import { useState } from 'react';
import type { ResumeInitialState } from '@checkout/shared';
import { newClientId, tabClient } from './clientId';
import { ActionLog } from './ActionLog';
import { useChaos } from './ChaosPanel';
import type { Chaos } from './ChaosPanel';
import { DevDrawer } from './DevDrawer';
import { CheckoutPane } from './CheckoutPane';
import { PaneColumn, usePulse } from './PaneColumn';
import { createPaneControls } from './paneControls';
import type { PaneControls } from './paneControls';
import type { ClientInfo } from './api';
import { usePath } from './navigate';
import { StartScreen } from './StartScreen';

const CHECKOUT_ROUTE = /^\/checkout\/([^/]+)$/;
const RESUME_ROUTE = /^\/resume\/([^/]+)$/;

/**
 * `/checkout/:id` is the demo: a desktop pane and a phone-frame pane side by side, on the same
 * session. `/resume/:id` is the link handed to a real second device, so it shows only the phone view,
 * and is the only route that can start from a pre-rendered `initialState` (the demo never does).
 */
export function App({ initialState }: { initialState?: ResumeInitialState } = {}) {
  const path = usePath();
  const checkout = CHECKOUT_ROUTE.exec(path);
  const resume = RESUME_ROUTE.exec(path);

  if (resume) {
    const id = decodeURIComponent(resume[1]!);
    return <ResumeScreen key={id} sessionId={id} initialState={initialState} />;
  }
  if (checkout) {
    const id = decodeURIComponent(checkout[1]!);
    // No key: moving to another checkout (a new one from the drawer, or Start again) keeps the demo's
    // drawer as it is, and only the panes start over (they are keyed by session below).
    return <SplitDemo sessionId={id} />;
  }
  return (
    <main>
      <StartScreen />
    </main>
  );
}

function SplitDemo({ sessionId }: { sessionId: string }) {
  // The desktop pane is this tab (so it matches the client that started the checkout).
  const [desktop] = useState(() => tabClient('web'));
  // How the dev drawer's scenarios press buttons on, and read the status of, the two panes. It lives
  // as long as the drawer; each pane registers when it mounts and leaves when it goes.
  const [controls] = useState(createPaneControls);
  // One set of chaos actions, for the drawer's buttons and for the prompts in the action log.
  const chaos = useChaos(sessionId, desktop);

  return (
    <>
      {/* Only the demo has it (not /resume), and it stays hidden unless the server has dev tools on.
          It comes first because it brings the page's top bar. */}
      <DevDrawer chaos={chaos} controls={controls} />
      {/* A new session means new panes (the phone is a new device each time), but not a new drawer. */}
      <SplitPanes key={sessionId} sessionId={sessionId} desktop={desktop} controls={controls} chaos={chaos} />
    </>
  );
}

function SplitPanes({
  sessionId,
  desktop,
  controls,
  chaos,
}: {
  sessionId: string;
  desktop: ClientInfo;
  controls: PaneControls;
  chaos: Chaos;
}) {
  // The phone is a simulated second device with an id of its own, new with each checkout.
  const [phone] = useState(() => ({ clientId: newClientId(), surface: 'mobile' as const }));
  const desktopPulse = usePulse();
  const phonePulse = usePulse();

  return (
    <>
      <div className="demo">
        {/* The log sits on top of the desktop pane, which is at the bottom of its column. */}
        <div className="demo-col-left">
          <ActionLog controls={controls} chaos={chaos} />
          <PaneColumn
            className="demo-col-desktop"
            frameClass="demo-desktop"
            testId="desktop-pane"
            label="Desktop"
            detail="this tab"
            pulse={desktopPulse}
          >
            <CheckoutPane
              sessionId={sessionId}
              client={desktop}
              onRemoteUpdate={desktopPulse.notify}
              controls={controls}
              paneName="desktop"
            />
          </PaneColumn>
        </div>
        <PaneColumn
          className="demo-col-phone"
          frameClass="phone-frame"
          testId="phone-pane"
          label="Phone"
          detail="simulated second device"
          frameLabel="Phone preview"
          pulse={phonePulse}
        >
          <CheckoutPane
            sessionId={sessionId}
            client={phone}
            onRemoteUpdate={phonePulse.notify}
            controls={controls}
            paneName="phone"
          />
        </PaneColumn>
      </div>
    </>
  );
}

/** A real second device: the phone layout fills the screen, with this tab's own identity. */
function ResumeScreen({ sessionId, initialState }: { sessionId: string; initialState?: ResumeInitialState }) {
  const [client] = useState(() => tabClient('mobile'));
  return (
    <div className="mobile-full">
      <CheckoutPane sessionId={sessionId} client={client} initialState={initialState} />
    </div>
  );
}
