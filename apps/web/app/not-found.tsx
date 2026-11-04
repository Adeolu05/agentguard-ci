import { EmptyState, TextLink } from "@/components/ui";

export default function NotFound() {
  return (
    <EmptyState title="Not found">
      That run, scenario or finding does not exist in the configured reports directory. <TextLink href="/runs">Back to test runs</TextLink>
    </EmptyState>
  );
}
