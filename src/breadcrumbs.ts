const MAX_BREADCRUMBS = 25;

export interface Breadcrumb {
  category: string;
  message: string;
  data?: Record<string, unknown>;
  level?: string;
  timestamp: string;
}

export class BreadcrumbBuffer {
  private items: Breadcrumb[] = [];

  add(category: string, message: string, data?: Record<string, unknown>, level?: string): void {
    const crumb: Breadcrumb = {
      category,
      message,
      timestamp: new Date().toISOString(),
      ...(data && { data }),
      ...(level && { level }),
    };

    if (this.items.length >= MAX_BREADCRUMBS) {
      this.items.shift();
    }
    this.items.push(crumb);
  }

  toArray(): Breadcrumb[] {
    return [...this.items];
  }

  get length(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }
}
