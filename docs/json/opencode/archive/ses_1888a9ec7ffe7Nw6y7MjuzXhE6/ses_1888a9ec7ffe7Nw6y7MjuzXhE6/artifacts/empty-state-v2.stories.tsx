import { EmptyStateV2 } from "./empty-state-v2"

const docs = `### Overview
Empty state component for empty lists, errors, and search results.

### API
- \`title\`, \`description\` - text content
- \`icon\`, \`iconEl\` - icon or custom element
- \`actionLabel\`, \`onAction\` - optional action button
- \`variant\`: "default" | "error" | "search-no-results"

### Variants
- Default: neutral icon, suitable for empty lists/sections
- Error: critical icon + background, for error states
- Search no results: search icon, for empty search results

### Accessibility
- Uses semantic heading and paragraph elements
- Action button is a native button element
- Entrance animation respects prefers-reduced-motion
`

export default {
  title: "UI V2/EmptyStateV2",
  id: "components-empty-state-v2",
  component: EmptyStateV2,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
  args: {
    title: "No items found",
    description: "Try adjusting your search or filters to find what you're looking for.",
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "error", "search-no-results"],
    },
  },
}

export const Playground = {}

export const Default = {
  args: {
    variant: "default",
  },
}

export const Error = {
  args: {
    variant: "error",
    title: "Something went wrong",
    description: "An unexpected error occurred. Please try again.",
    actionLabel: "Retry",
    onAction: () => alert("Retry clicked"),
  },
}

export const SearchNoResults = {
  args: {
    variant: "search-no-results",
    title: "No results found",
    description: "We couldn't find any matches for your search. Try different keywords.",
  },
}

export const WithAction = {
  args: {
    title: "Your project is empty",
    description: "Get started by adding your first file or creating a new project.",
    actionLabel: "Create Project",
    onAction: () => alert("Create clicked"),
  },
}

export const CustomIcon = {
  args: {
    title: "Custom illustration",
    description: "This state uses a custom icon element instead of the default.",
    iconEl: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" />
        <path d="M2 17L12 22L22 17" stroke="currentColor" />
        <path d="M2 12L12 17L22 12" stroke="currentColor" />
      </svg>
    ),
  },
}
