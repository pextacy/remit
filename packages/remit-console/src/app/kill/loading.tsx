/**
 * The kill-switch screen reads the chain before it can answer, and until it has, it says
 * so. The one thing this screen must never do is imply a reading it has not taken.
 */
export default function Loading() {
  return (
    <div className="head">
      <span className="eyebrow">agent authority</span>
      <h1>Reading</h1>
      <p className="lede">
        Membership is observed by simulating a call under the role, because Roles 2.1.0
        exposes no getter for it. Until that answers, this screen is telling you nothing
        about the switch.
      </p>
    </div>
  );
}
