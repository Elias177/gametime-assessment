import { useState } from 'react';
import { newClientId, tabClient } from './clientId';
import { ChaosPanel } from './ChaosPanel';
import { CheckoutPane } from './CheckoutPane';
import { usePath } from './navigate';
import { StartScreen } from './StartScreen';

const CHECKOUT_ROUTE = /^\/checkout\/([^/]+)$/;
const RESUME_ROUTE = /^\/resume\/([^/]+)$/;

/**
 * `/checkout/:id` is the demo: a desktop pane and a phone-frame pane side by side, on the same
 * session. `/resume/:id` is the link handed to a real second device, so it shows only the phone view.
 */
export function App() {
  const path = usePath();
  const checkout = CHECKOUT_ROUTE.exec(path);
  const resume = RESUME_ROUTE.exec(path);

  if (resume) {
    const id = decodeURIComponent(resume[1]!);
    return <ResumeScreen key={id} sessionId={id} />;
  }
  if (checkout) {
    const id = decodeURIComponent(checkout[1]!);
    return <SplitDemo key={id} sessionId={id} />;
  }
  return (
    <main>
      <StartScreen />
    </main>
  );
}

function SplitDemo({ sessionId }: { sessionId: string }) {
  // One identity per pane, made once. The desktop pane is this tab (so it matches the client that
  // started the checkout); the phone is a simulated second device with an id of its own.
  const [desktop] = useState(() => tabClient('web'));
  const [phone] = useState(() => ({ clientId: newClientId(), surface: 'mobile' as const }));

  return (
    <>
      <div className="demo">
        <div className="demo-desktop" data-testid="desktop-pane">
          <CheckoutPane sessionId={sessionId} client={desktop} />
        </div>
        <div className="phone-frame" data-testid="phone-pane" aria-label="Phone preview">
          <CheckoutPane sessionId={sessionId} client={phone} />
        </div>
      </div>
      {/* Only the demo has it (not /resume), and it renders nothing unless the server has dev tools on. */}
      <ChaosPanel sessionId={sessionId} client={desktop} />
    </>
  );
}

/** A real second device: the phone layout fills the screen, with this tab's own identity. */
function ResumeScreen({ sessionId }: { sessionId: string }) {
  const [client] = useState(() => tabClient('mobile'));
  return (
    <div className="mobile-full">
      <CheckoutPane sessionId={sessionId} client={client} />
    </div>
  );
}
