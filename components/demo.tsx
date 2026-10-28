import {
  FileCheck2,
  Hash,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  WalletCards,
} from "lucide-react";
import { GlowCard } from "@/components/ui/spotlight-card";

interface SpotlightStepsProps {
  totalEntries?: number;
  totalWinners?: number;
  totalVipTickets?: number;
  totalFreeSpins?: number;
}

export function Default({ totalEntries = 60, totalWinners = 2, totalVipTickets = 1, totalFreeSpins = 4 }: SpotlightStepsProps) {
  const steps = [
    {
      number: "01",
      icon: WalletCards,
      title: "Pay with M-Pesa",
      body: "Enter your Safaricom number and approve the KES 500 STK Push on your phone. Your PIN stays private.",
      foot: "Server-confirmed payment",
      footIcon: LockKeyhole,
    },
    {
      number: "02",
      icon: Hash,
      title: "Your outcome locks",
      body: `Payment assigns the next position in a pre-shuffled pool of ${totalWinners - totalVipTickets} Regular ticket, ${totalVipTickets} VIP ticket, ${totalFreeSpins} Free Spins and ${totalEntries - totalWinners - totalFreeSpins} No-Win positions. No rerolls.`,
      foot: "Committed before play",
      footIcon: ShieldCheck,
    },
    {
      number: "03",
      icon: Sparkles,
      title: "Spin & get the receipt",
      body: "Reveal in seconds. Win or not, your masked result joins the public hash-chained ledger instantly.",
      foot: "Independently verifiable",
      footIcon: FileCheck2,
    },
  ];

  return (
    <div className="steps-grid" aria-label="Entry steps">
      {steps.map((step, index) => {
        const Icon = step.icon;
        const FootIcon = step.footIcon;
        return (
          <GlowCard key={step.number} customSize glowColor="green" className="step-glow">
            <article className={`step-card ${index === 1 ? "featured-step" : ""}`}>
              <div className="step-top">
                <span>{step.number}</span>
                <div><Icon size={25} /></div>
              </div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              <span className="step-foot"><FootIcon size={14} /> {step.foot}</span>
            </article>
          </GlowCard>
        );
      })}
    </div>
  );
}
