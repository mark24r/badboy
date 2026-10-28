import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Info,
  LoaderCircle,
  Music2,
  ShieldCheck,
  Ticket,
  WalletCards,
} from 'lucide-react';
import Wheel, { targetRotationForOutcome } from './Wheel.jsx';
import { FairnessModal, PaymentModal, ResultModal } from './Modals.jsx';
import { api, scrollToSection, wait } from './lib.js';

const eventPhotos = [
  '/images/detty/hands-up-900.webp',
  '/images/detty/clapping-800.webp',
  '/images/detty/barrier-800.webp',
  '/images/detty/front-row-800.webp',
];

function Logo() {
  return (
    <a className="detty-brand" href="/" aria-label="Detty Dezemba Festival ticket spin home">
      <span className="detty-event-logos" aria-hidden="true">
        <img src="/images/detty/kola-gold.webp" alt="" width="157" height="180" />
        <span>×</span>
        <img src="/images/detty/av-gold.webp" alt="" width="180" height="148" />
      </span>
      <span className="detty-brand-copy"><strong>DETTY DEZEMBA</strong><small>FESTIVAL · TICKET SPIN</small></span>
    </a>
  );
}

function LoadingScreen({ error, onRetry }) {
  return (
    <div className="loading-screen">
      <Logo />
      {error ? (
        <div className="loading-error">
          <Info size={24} />
          <h1>We couldn’t load the drop.</h1>
          <p>{error}</p>
          <button className="button button-primary" type="button" onClick={onRetry}>Try again</button>
        </div>
      ) : (
        <div className="loading-indicator"><LoaderCircle className="spin-icon" size={25} /> Opening the spinner…</div>
      )}
    </div>
  );
}

export default function App() {
  const [campaign, setCampaign] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [fairnessOpen, setFairnessOpen] = useState(false);
  const [activeEntry, setActiveEntry] = useState(null);
  const [resultEntry, setResultEntry] = useState(null);
  const [resultBonusEntry, setResultBonusEntry] = useState(null);
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [spinDuration, setSpinDuration] = useState(4200);
  const [toast, setToast] = useState(null);
  const [photoIndex, setPhotoIndex] = useState(0);

  const loadCampaign = useCallback(async () => {
    try {
      const data = await api('/api/campaign');
      setCampaign(data);
      setLoadError('');
    } catch (error) {
      setLoadError(error.message);
    }
  }, []);

  useEffect(() => {
    loadCampaign();
  }, [loadCampaign]);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const interval = setInterval(() => {
      setPhotoIndex((current) => (current + 1) % eventPhotos.length);
    }, 6500);
    return () => clearInterval(interval);
  }, []);

  const showToast = useCallback((message) => {
    setToast({ message, id: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(timeout);
  }, [toast]);

  const handleEntry = useCallback((entry) => {
    setActiveEntry(entry);
    if (entry?.id) sessionStorage.setItem('tiketi-active-entry', entry.id);
    if (entry?.paymentStatus === 'paid') loadCampaign();
  }, [loadCampaign]);

  useEffect(() => {
    const savedId = sessionStorage.getItem('tiketi-active-entry');
    if (!savedId) return;
    api(`/api/entries/${savedId}`).then(async ({ entry }) => {
      let restorable = entry;
      let chainLength = 0;
      while (restorable.spinStatus === 'completed' && restorable.freeSpinEntryId && chainLength < 25) {
        const response = await api(`/api/entries/${restorable.freeSpinEntryId}`);
        restorable = response.entry;
        chainLength += 1;
      }
      if (restorable.paymentStatus === 'paid' && restorable.spinStatus === 'ready') {
        setActiveEntry(restorable);
        sessionStorage.setItem('tiketi-active-entry', restorable.id);
      } else sessionStorage.removeItem('tiketi-active-entry');
    }).catch(() => sessionStorage.removeItem('tiketi-active-entry'));
  }, []);

  const canSpin = activeEntry?.paymentStatus === 'paid' && activeEntry?.spinStatus === 'ready';

  const openEntry = () => {
    if (campaign?.status === 'closed') {
      showToast('This drop is closed. New entries are no longer available.');
      return;
    }
    if (canSpin) scrollToSection('spin-card');
    else setPaymentOpen(true);
  };

  const handleSpinReady = useCallback((entry) => {
    handleEntry(entry);
    setPaymentOpen(false);
    setTimeout(() => scrollToSection('spin-card'), 120);
  }, [handleEntry]);

  const handleSpin = async () => {
    if (spinning) return;
    if (!canSpin) {
      openEntry();
      return;
    }
    setSpinning(true);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reducedMotion ? 450 : 4200;
    setSpinDuration(duration);
    try {
      const response = await api(`/api/entries/${activeEntry.id}/spin`, { method: 'POST', body: '{}' });
      const targetModulo = targetRotationForOutcome(response.entry.outcome);
      setRotation((current) => {
        const currentModulo = ((current % 360) + 360) % 360;
        const alignment = (targetModulo - currentModulo + 360) % 360;
        return current + (reducedMotion ? 360 : 360 * 7) + alignment;
      });
      await wait(duration + 120);
      setCampaign(response.campaign);
      setActiveEntry(response.bonusEntry || response.entry);
      setResultEntry(response.entry);
      setResultBonusEntry(response.bonusEntry || null);
      if (response.bonusEntry) sessionStorage.setItem('tiketi-active-entry', response.bonusEntry.id);
      else sessionStorage.removeItem('tiketi-active-entry');
    } catch (error) {
      showToast(error.message);
    } finally {
      setSpinning(false);
    }
  };

  if (!campaign) return <LoadingScreen error={loadError} onRetry={loadCampaign} />;

  const progress = Math.min(100, (campaign.entriesUsed / campaign.totalEntries) * 100);

  return (
    <div className="spin-app">
      <div className="detty-photo-backdrop" aria-hidden="true">
        {eventPhotos.map((photo, index) => (
          <img key={photo} className={index === photoIndex ? 'active' : ''} src={photo} alt="" />
        ))}
        <div className="detty-photo-shade" />
      </div>
      <header className="spin-header">
        <Logo />
      </header>

      <main className="spin-main">
        <div className="spin-title">
          <div className="drop-label"><span className={`live-dot ${campaign.status === 'closed' ? 'closed' : ''}`} /> DECEMBER 2026 <i /> NAIROBI</div>
          <h1><span>Detty<br className="mobile-title-break" /> Dezemba</span>Ticket spin.</h1>
          <p>1 Regular ticket · 4 Free Spins · KES 500 per paid entry</p>
        </div>

        <section className="focus-card" id="spin-card" aria-label="Detty Dezemba ticket spinning wheel">
          <div className="focus-glow" aria-hidden="true" />
          <div className="spin-card-top">
            <span><Music2 size={16} /> DETTY DEZEMBA · TICKET DROP</span>
            <span className="tickets-pill"><Ticket size={14} /> {campaign.ticketsRemaining} / {campaign.totalWinners} ticket left</span>
          </div>

          <Wheel
            rotation={rotation}
            duration={spinDuration}
            spinning={spinning}
            canSpin={canSpin}
            bonus={canSpin && activeEntry.amount === 0}
            closed={campaign.status === 'closed' && !canSpin}
            onSpin={handleSpin}
          />

          <div className="spin-status" aria-live="polite">
            {spinning ? (
              <><LoaderCircle size={16} className="spin-icon" /> Outcome locked. Revealing your receipt…</>
            ) : canSpin ? (
              <><CheckCircle2 size={16} /> {activeEntry.amount === 0 ? 'Free spin' : 'Paid entry'} {activeEntry.receipt} is ready{activeEntry.amount === 0 ? ' — no payment needed.' : ' to reveal.'}</>
            ) : (
              <><WalletCards size={16} /> KES 500 per paid entry · Ticket {campaign.ticketOdds} · Any reward {campaign.startingOdds}</>
            )}
          </div>
          <p className="wheel-disclaimer">Wheel areas match the starting pool: 4% Regular Ticket · 16% Free Spin · 80% No Win. The committed pool decides each outcome.</p>

          <div className="pool-progress">
            <div><span>Entry pool</span><strong>{campaign.entriesUsed} <i>/ {campaign.totalEntries}</i></strong></div>
            <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
            <div className="pool-progress-foot">
              <span>{campaign.entriesRemaining} positions left</span>
              <span>{campaign.currentPool.winningEntries} ticket · {campaign.currentPool.freeSpinEntries} spins left</span>
            </div>
          </div>

          <button
            className="button focus-entry-button"
            type="button"
            onClick={canSpin ? handleSpin : openEntry}
            disabled={spinning || (campaign.status === 'closed' && !canSpin)}
          >
            {spinning ? <LoaderCircle size={18} className="spin-icon" /> : <Ticket size={18} />}
            {spinning ? 'Revealing your result…' : canSpin ? (activeEntry.amount === 0 ? 'Use my free spin' : 'Spin my paid entry') : 'Pay KES 500 & spin'}
            {!spinning && <ArrowRight size={18} />}
          </button>

          <div className="focus-secondary-actions">
            <button type="button" onClick={() => setFairnessOpen(true)}><ShieldCheck size={15} /> How fairness works</button>
          </div>
        </section>

        <p className="focus-legal">18+ · No real money is accepted · Maximum {campaign.maxEntriesPerPhone} paid entries per number</p>
        <a className="detty-photo-credit" href="https://dettydezemba.com/" target="_blank" rel="noreferrer">Event photos & festival inspiration: dettydezemba.com</a>
      </main>

      <PaymentModal
        open={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        campaign={campaign}
        onEntry={handleEntry}
        onSpinReady={handleSpinReady}
      />
      {resultEntry && (
        <ResultModal
          entry={resultEntry}
          campaign={campaign}
          bonusEntry={resultBonusEntry}
          onClose={() => {
            setResultEntry(null);
            setResultBonusEntry(null);
          }}
          onFreeSpin={() => {
            setResultEntry(null);
            setResultBonusEntry(null);
            setTimeout(() => scrollToSection('spin-card'), 80);
          }}
          onToast={showToast}
        />
      )}
      {fairnessOpen && <FairnessModal campaign={campaign} onClose={() => setFairnessOpen(false)} onToast={showToast} />}
      {toast && <div className="toast" role="status" key={toast.id}><CheckCircle2 size={18} /> {toast.message}</div>}
    </div>
  );
}
