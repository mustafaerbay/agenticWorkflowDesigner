import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/States";

export default function NotFoundPage() {
  return (
    <EmptyState
      icon={Compass}
      title="Page not found"
      description="The page you are looking for doesn't exist."
      action={
        <Button asChild size="sm">
          <Link to="/">Go to dashboard</Link>
        </Button>
      }
    />
  );
}
