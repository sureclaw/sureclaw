import { Logo } from "@/components/icons/logo";
import { PROJECT_NAME, GITHUB_URL } from "@/lib/constants";

const footerLinks = [
  {
    title: "product",
    links: [
      { label: "Features", href: "#features" },
      { label: "How It Works", href: "#how-it-works" },
      { label: "Documentation", href: "#" },
    ],
  },
  {
    title: "community",
    links: [
      { label: "GitHub", href: GITHUB_URL },
      { label: "Discord", href: "#" },
      { label: "Twitter / X", href: "#" },
    ],
  },
  {
    title: "resources",
    links: [
      { label: "Getting Started", href: "#" },
      { label: "Contributing", href: "#" },
      { label: "License (MIT)", href: "#" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-[1280px] px-8 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-12">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-2">
              <Logo className="w-6 h-6" />
              <span className="font-mono font-bold text-[15px] tracking-tight text-accent">
                {PROJECT_NAME}
              </span>
            </div>
            <p className="text-xs text-text-tertiary leading-relaxed">
              Open source AI agent framework.
              <br />
              Free forever. MIT licensed.
            </p>
          </div>

          {/* Link columns */}
          {footerLinks.map((group) => (
            <div key={group.title}>
              <h4 className="font-mono text-[10px] font-semibold uppercase tracking-[1.2px] text-text-secondary mb-4">
                {group.title}
              </h4>
              <ul className="flex flex-col gap-2.5">
                {group.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-xs text-text-tertiary hover:text-text-primary transition-colors"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="mt-8 pt-6 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-[11px] text-text-tertiary">
            &copy; {new Date().getFullYear()} ax. MIT License.
          </p>
          <p className="text-[11px] text-text-tertiary">
            Made with mass amounts of mass-produced coffee.
          </p>
        </div>
      </div>
    </footer>
  );
}
