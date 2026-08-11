// 0.4.0 (prototype): the action pulls in @actions/core and
// @actions/github, which the prototype workspace does not install.
// The runtime action (when distributed via the marketplace) will
// have the real packages; here we declare enough of the API
// surface to type-check the source. Replace this stub with
// `npm install @actions/core @actions/github` for a real build.

declare module "@actions/core" {
  export function getInput(name: string): string;
  export function setFailed(message: string): void;
  export function info(message: string): void;
  export function warning(message: string): void;
  export function debug(message: string): void;
}

declare module "@actions/github" {
  type Octokit = any;
  type PullListReviews = any;
  type IssuesAddLabels = any;
  type IssuesCreateLabel = any;
  type IssuesGetLabel = any;
  type PullRequestPayload = { number: number };
  type RepoInfo = { owner: string; repo: string };
  type OctokitRest = {
    issues: {
      addLabels: (args: { owner: string; repo: string; issue_number: number; labels: string[] }) => Promise<unknown>;
      createLabel: (args: { owner: string; repo: string; name: string; color: string; description: string }) => Promise<unknown>;
      getLabel: (args: { owner: string; repo: string; name: string }) => Promise<unknown>;
    };
    pulls: {
      listReviews: (args: { owner: string; repo: string; pull_number: number; per_page?: number }) => Promise<unknown>;
    };
  };
  type OctokitInstance = {
    rest: OctokitRest;
    paginate: (fn: (...args: any[]) => any, args: Record<string, unknown>) => Promise<any[]>;
  };
  export function getOctokit(token: string): OctokitInstance;
  export const context: {
    payload: { pull_request?: PullRequestPayload };
    repo: RepoInfo;
  };
}
