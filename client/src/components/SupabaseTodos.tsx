import { useEffect, useState } from "react";
import { supabase } from "@/utils/supabase";

interface Todo {
  id: number | string;
  name: string;
}

export default function SupabaseTodos() {
  const [todos, setTodos] = useState<Todo[]>([]);

  useEffect(() => {
    let active = true;

    async function getTodos() {
      const { data, error } = await supabase
        .from("todos")
        .select("id, name")
        .order("id");

      if (!active || error || !data) return;
      setTodos(data as Todo[]);
    }

    void getTodos();
    return () => {
      active = false;
    };
  }, []);

  if (todos.length === 0) return null;

  return (
    <section className="mx-auto mb-5 max-w-[1440px] px-4 sm:px-6 lg:px-8">
      <div className="webasi-card p-5 sm:p-6">
        <p className="webasi-label mb-2">Supabase todos</p>
        <ul className="space-y-2 text-sm text-[#1E293B]">
          {todos.map((todo) => <li key={todo.id}>{todo.name}</li>)}
        </ul>
      </div>
    </section>
  );
}
