"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Skill {
  name: string;
  description?: string;
  content?: string;
  [key: string]: unknown;
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillContent, setSkillContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);

  useEffect(() => {
    api
      .getSkills()
      .then((data) => setSkills(data as Skill[]))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function openSkill(skill: Skill) {
    setSelectedSkill(skill);
    setContentLoading(true);
    api
      .getSkill(skill.name)
      .then((data) => {
        const d = data as Record<string, unknown>;
        setSkillContent(
          (d.content as string) || (d.skillMd as string) || JSON.stringify(d, null, 2)
        );
      })
      .catch(() => setSkillContent("Failed to load skill content"))
      .finally(() => setContentLoading(false));
  }

  function closeModal() {
    setSelectedSkill(null);
    setSkillContent(null);
  }

  if (loading) {
    return (
      <div>
        <div className="mb-8">
          <h2 className="text-2xl font-semibold tracking-tight">Skills</h2>
          <p className="text-sm text-neutral-500 mt-1">Capabilities and learned behaviors</p>
        </div>
        <p className="text-sm text-neutral-400">Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Skills</h2>
          <p className="text-sm text-neutral-500 mt-1">
            Capabilities and learned behaviors
          </p>
        </div>
        <button
          onClick={() =>
            alert("To create a new skill, chat with Jimmy and ask to learn something new.")
          }
          className="px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
        >
          + Create Skill
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Failed to load skills: {error}
        </div>
      )}

      {skills.length === 0 && !error ? (
        <div className="rounded-xl border border-neutral-200 bg-white px-6 py-12 text-center">
          <p className="text-sm text-neutral-400">No skills yet</p>
          <p className="text-xs text-neutral-300 mt-1">
            Chat with Jimmy to teach new skills
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {skills.map((skill) => (
            <button
              key={skill.name}
              onClick={() => openSkill(skill)}
              className="text-left rounded-xl border border-neutral-200 bg-white p-5 hover:border-blue-200 hover:bg-blue-50/30 transition-colors"
            >
              <h3 className="text-sm font-medium text-neutral-800 mb-1">
                {skill.name}
              </h3>
              <p className="text-xs text-neutral-400 line-clamp-2">
                {skill.description || "No description"}
              </p>
            </button>
          ))}
        </div>
      )}

      {/* Modal */}
      {selectedSkill && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={closeModal}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200">
              <h3 className="text-lg font-semibold text-neutral-800">
                {selectedSkill.name}
              </h3>
              <button
                onClick={closeModal}
                className="text-neutral-400 hover:text-neutral-600 text-lg"
              >
                x
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {contentLoading ? (
                <p className="text-sm text-neutral-400">Loading...</p>
              ) : (
                <pre className="text-sm text-neutral-700 whitespace-pre-wrap font-mono leading-relaxed">
                  {skillContent}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
