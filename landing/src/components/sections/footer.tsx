import { Logo } from "@/components/icons/logo";

const footerLinks = [
  {
    title: "Project",
    links: [
      { label: "Features", href: "#features" },
      { label: "How It Works", href: "#how-it-works" },
      { label: "Documentation", href: "#" },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "GitHub", href: "https://github.com/ax-llm/ax" },
      { label: "Discord", href: "#" },
      { label: "Twitter / X", href: "#" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Getting Started", href: "#" },
      { label: "Contributing", href: "#" },
      { label: "License (MIT)", href: "#" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border bg-bg-primary">
      <div className="mx-auto max-w-[1200px] px-6 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <Logo className="w-6 h-6" />
              <span className="font-semibold tracking-tight">ax</span>
            </div>
            <p className="text-sm text-text-tertiary leading-relaxed">
              Open source AI agent framework.
              <br />
              Free forever. MIT licensed.
            </p>
          </div>

          {/* Link columns */}
          {footerLinks.map((group) => (
            <div key={group.title}>
              <h4 className="text-sm font-medium text-text-primary mb-3">
                {group.title}
              </h4>
              <ul className="flex flex-col gap-2">
                {group.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-sm text-text-tertiary hover:text-text-secondary transition-colors"
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
        <div className="mt-12 pt-6 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-text-tertiary">
            &copy; {new Date().getFullYear()} ax. MIT License.
          </p>
          <p className="text-xs text-text-tertiary">
            Made with mass amounts of mass-produced coffee.
          </p>
        </div>
      </div>
    </footer>
  );
}
