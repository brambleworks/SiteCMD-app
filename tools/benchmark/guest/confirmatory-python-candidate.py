import ast
import importlib.util
import json
import os
from pathlib import Path
import ssl
import sys
from types import ModuleType, SimpleNamespace


request_data = json.load(sys.stdin)
work_root = Path(os.environ.get("SITECMD_BENCHMARK_WORK_ROOT", "/work"))
entry = work_root / request_data["entry"]
source = entry.read_text(encoding="utf-8")


class UnknownEvaluation(Exception):
    pass


class ReturnValue(Exception):
    def __init__(self, value):
        self.value = value


class ConfigurationRejected(Exception):
    pass


class Config:
    def __init__(self, values):
        self.values = values

    def get_list_value(self, _section, key, default=None):
        return self.values.get(key, default)

    def get_bool_value(self, _section, key, default=None):
        return self.values.get(key, default)


class Evaluator:
    def __init__(self, environment):
        self.environment = environment
        self.functions = {}

    def evaluate(self, node, environment=None):
        env = self.environment if environment is None else environment
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            if node.id in env:
                return env[node.id]
            if node.id in self.functions:
                return self.functions[node.id]
            raise UnknownEvaluation(node.id)
        if isinstance(node, ast.List):
            return [self.evaluate(value, env) for value in node.elts]
        if isinstance(node, ast.Tuple):
            return tuple(self.evaluate(value, env) for value in node.elts)
        if isinstance(node, ast.Set):
            return {self.evaluate(value, env) for value in node.elts}
        if isinstance(node, ast.Dict):
            return {
                self.evaluate(key, env): self.evaluate(value, env)
                for key, value in zip(node.keys, node.values)
            }
        if isinstance(node, ast.Attribute):
            value = self.evaluate(node.value, env)
            if isinstance(value, dict) and node.attr in value:
                return value[node.attr]
            try:
                return getattr(value, node.attr)
            except AttributeError as error:
                raise UnknownEvaluation(node.attr) from error
        if isinstance(node, ast.Subscript):
            return self.evaluate(node.value, env)[self.evaluate(node.slice, env)]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return not self.evaluate(node.operand, env)
        if isinstance(node, ast.BoolOp):
            if isinstance(node.op, ast.And):
                for value in node.values:
                    if not self.evaluate(value, env):
                        return False
                return True
            for value in node.values:
                if self.evaluate(value, env):
                    return True
            return False
        if isinstance(node, ast.IfExp):
            branch = node.body if self.evaluate(node.test, env) else node.orelse
            return self.evaluate(branch, env)
        if isinstance(node, ast.BinOp):
            left = self.evaluate(node.left, env)
            right = self.evaluate(node.right, env)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Mod):
                return left % right
            raise UnknownEvaluation(type(node.op).__name__)
        if isinstance(node, ast.Compare):
            left = self.evaluate(node.left, env)
            for operator, comparator in zip(node.ops, node.comparators):
                right = self.evaluate(comparator, env)
                if isinstance(operator, (ast.Eq, ast.Is)):
                    passed = left == right
                elif isinstance(operator, (ast.NotEq, ast.IsNot)):
                    passed = left != right
                elif isinstance(operator, ast.In):
                    passed = left in right
                elif isinstance(operator, ast.NotIn):
                    passed = left not in right
                else:
                    raise UnknownEvaluation(type(operator).__name__)
                if not passed:
                    return False
                left = right
            return True
        if isinstance(node, ast.ListComp):
            return self.evaluate_list_comprehension(node, env)
        if isinstance(node, ast.JoinedStr):
            parts = []
            for value in node.values:
                if isinstance(value, ast.Constant):
                    parts.append(str(value.value))
                elif isinstance(value, ast.FormattedValue):
                    parts.append(str(self.evaluate(value.value, env)))
            return "".join(parts)
        if isinstance(node, ast.Call):
            function = self.evaluate(node.func, env)
            args = [self.evaluate(value, env) for value in node.args]
            kwargs = {
                keyword.arg: self.evaluate(keyword.value, env)
                for keyword in node.keywords
                if keyword.arg is not None
            }
            if isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return self.call_user_function(function, args, kwargs, env)
            if function in {all, any, bool, len, list, set, str, tuple}:
                return function(*args, **kwargs)
            owner = getattr(function, "__self__", None)
            name = getattr(function, "__name__", "")
            if isinstance(owner, Config) and name in {"get_list_value", "get_bool_value"}:
                return function(*args, **kwargs)
            if isinstance(owner, str) and name in {"split", "strip", "lower"}:
                return function(*args, **kwargs)
            raise UnknownEvaluation(name or "call")
        raise UnknownEvaluation(type(node).__name__)

    def evaluate_list_comprehension(self, node, environment):
        if len(node.generators) != 1 or node.generators[0].is_async:
            raise UnknownEvaluation("list comprehension")
        generator = node.generators[0]
        values = self.evaluate(generator.iter, environment)
        result = []
        for value in values:
            local = dict(environment)
            self.assign(generator.target, value, local)
            if all(self.evaluate(condition, local) for condition in generator.ifs):
                result.append(self.evaluate(node.elt, local))
        return result

    def assign(self, target, value, environment):
        if isinstance(target, ast.Name):
            environment[target.id] = value
            return
        if isinstance(target, (ast.Tuple, ast.List)):
            for item, member in zip(target.elts, value):
                self.assign(item, member, environment)
            return
        raise UnknownEvaluation("assignment")

    def call_user_function(self, function, args, kwargs, closure):
        local = dict(closure)
        parameters = [*function.args.posonlyargs, *function.args.args]
        defaults = [None] * (len(parameters) - len(function.args.defaults)) + list(
            function.args.defaults
        )
        for index, parameter in enumerate(parameters):
            if index < len(args):
                local[parameter.arg] = args[index]
            elif parameter.arg in kwargs:
                local[parameter.arg] = kwargs[parameter.arg]
            elif defaults[index] is not None:
                local[parameter.arg] = self.evaluate(defaults[index], closure)
            else:
                raise UnknownEvaluation(parameter.arg)
        try:
            self.execute_statements(function.body, local)
        except ReturnValue as returned:
            return returned.value
        return None

    def execute_statements(self, statements, environment=None):
        env = self.environment if environment is None else environment
        for statement in statements:
            try:
                if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    self.functions[statement.name] = statement
                elif isinstance(statement, ast.Assign):
                    value = self.evaluate(statement.value, env)
                    for target in statement.targets:
                        self.assign(target, value, env)
                elif isinstance(statement, ast.AnnAssign) and statement.value is not None:
                    self.assign(statement.target, self.evaluate(statement.value, env), env)
                elif isinstance(statement, ast.If):
                    selected = (
                        statement.body
                        if self.evaluate(statement.test, env)
                        else statement.orelse
                    )
                    self.execute_statements(selected, env)
                elif isinstance(statement, ast.Return):
                    raise ReturnValue(
                        self.evaluate(statement.value, env) if statement.value is not None else None
                    )
                elif isinstance(statement, ast.Raise):
                    raise ConfigurationRejected()
            except UnknownEvaluation:
                continue


def is_cors_call(node):
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "add_middleware"
        and (
            any(keyword.arg == "allow_origins" for keyword in node.keywords)
            or any(
                isinstance(argument, (ast.Name, ast.Attribute))
                and ast.unparse(argument).endswith("CORSMiddleware")
                for argument in node.args
            )
        )
    )


def nested_statement_blocks(statement):
    blocks = []
    for field in ("body", "orelse", "finalbody"):
        value = getattr(statement, field, None)
        if isinstance(value, list):
            blocks.append(value)
    for handler in getattr(statement, "handlers", []):
        blocks.append(handler.body)
    return blocks


def find_cors_context(statements):
    for index, statement in enumerate(statements):
        for block in nested_statement_blocks(statement):
            found = find_cors_context(block)
            if found:
                return found
        for node in ast.walk(statement):
            if is_cors_call(node):
                return statements, index, node
    return None


def observe_cors(global_origins=None, config_values=None):
    tree = ast.parse(source, filename=str(entry))
    found = find_cors_context(tree.body)
    if not found:
        raise ValueError("CORS middleware call was not found")
    statements, index, call = found
    environment = {
        "all": all,
        "any": any,
        "bool": bool,
        "len": len,
        "list": list,
        "set": set,
        "str": str,
        "tuple": tuple,
        "config": Config(config_values or {}),
        "global_args": SimpleNamespace(cors_origins=global_origins),
    }
    evaluator = Evaluator(environment)
    rejected = False
    try:
        evaluator.execute_statements(statements[:index])
    except ConfigurationRejected:
        rejected = True
    observed = {"rejected": rejected}
    if not rejected:
        for keyword in call.keywords:
            if keyword.arg is None:
                try:
                    observed.update(evaluator.evaluate(keyword.value))
                except UnknownEvaluation:
                    pass
            else:
                try:
                    observed[keyword.arg] = evaluator.evaluate(keyword.value)
                except UnknownEvaluation:
                    observed[keyword.arg] = None
    return observed


def observe_lightrag():
    wildcard = observe_cors(global_origins="*")
    explicit = observe_cors(
        global_origins="https://one.example, https://two.example"
    )
    return {
        "wildcardCredentialsDisabled": wildcard.get("allow_origins") == ["*"]
        and wildcard.get("allow_credentials") is False,
        "explicitOriginsParsed": explicit.get("allow_origins")
        == ["https://one.example", "https://two.example"],
        "explicitOriginsCredentialsPreserved": explicit.get("allow_credentials") is True,
        "corsOptionsPreserved": explicit.get("allow_methods") == ["*"]
        and explicit.get("allow_headers") == ["*"]
        and explicit.get("expose_headers") == ["X-New-Token"],
    }


def observe_glances():
    default = observe_cors(config_values={})
    wildcard = observe_cors(
        config_values={"cors_origins": ["*"], "cors_credentials": True}
    )
    explicit = observe_cors(
        config_values={
            "cors_origins": ["https://one.example", "https://two.example"],
            "cors_credentials": True,
            "cors_methods": ["GET", "POST"],
            "cors_headers": ["Authorization", "Content-Type"],
        }
    )
    return {
        "defaultCredentialsDisabled": default.get("allow_origins") == ["*"]
        and default.get("allow_credentials") is False,
        "configuredWildcardCredentialsDisabled": wildcard["rejected"]
        or (
            wildcard.get("allow_origins") == ["*"]
            and wildcard.get("allow_credentials") is False
        ),
        "explicitOriginsPreserved": explicit.get("allow_origins")
        == ["https://one.example", "https://two.example"]
        and explicit.get("allow_credentials") is True,
        "configuredMethodsHeadersPreserved": explicit.get("allow_methods")
        == ["GET", "POST"]
        and explicit.get("allow_headers") == ["Authorization", "Content-Type"],
    }


def install_sagemaker_stubs(state):
    pb_utils = ModuleType("triton_python_backend_utils")
    pb_utils.get_input_tensor_by_name = lambda request, _name: request
    pb_utils.Tensor = lambda name, value: (name, value)
    pb_utils.InferenceResponse = lambda **values: values
    cloudpickle = ModuleType("cloudpickle")
    cloudpickle.load = lambda _file: (None, None)
    sagemaker = ModuleType("sagemaker")
    sagemaker.__path__ = []
    serve = ModuleType("sagemaker.serve")
    serve.__path__ = []
    validations = ModuleType("sagemaker.serve.validations")
    validations.__path__ = []
    integrity = ModuleType("sagemaker.serve.validations.check_integrity")

    def perform_integrity_check(**_values):
        state["integrityChecks"] += 1

    integrity.perform_integrity_check = perform_integrity_check
    sys.modules.update(
        {
            "triton_python_backend_utils": pb_utils,
            "cloudpickle": cloudpickle,
            "sagemaker": sagemaker,
            "sagemaker.serve": serve,
            "sagemaker.serve.validations": validations,
            "sagemaker.serve.validations.check_integrity": integrity,
        }
    )


def observe_sagemaker():
    state = {"integrityChecks": 0}
    install_sagemaker_stubs(state)
    model_directory = Path("/tmp/sitecmd-confirmatory-triton")
    model_directory.mkdir(parents=True, exist_ok=True)
    (model_directory / "serve.pkl").write_bytes(b"probe")
    (model_directory / "metadata.json").write_text("{}", encoding="utf-8")
    previous_directory = os.environ.get("TRITON_MODEL_DIR")
    os.environ["TRITON_MODEL_DIR"] = str(model_directory)
    default_context = ssl._create_default_https_context
    module = None
    error = None
    try:
        spec = importlib.util.spec_from_file_location("sitecmd_confirmatory_triton", entry)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except Exception as caught:
        error = caught
    finally:
        preserved = ssl._create_default_https_context is default_context
        ssl._create_default_https_context = default_context
        if previous_directory is None:
            os.environ.pop("TRITON_MODEL_DIR", None)
        else:
            os.environ["TRITON_MODEL_DIR"] = previous_directory
    model = getattr(module, "TritonPythonModel", None)
    diagnostics = [
        getattr(module, name, None)
        for name in (
            "_run_preflight_diagnostics",
            "_py_vs_parity_check",
            "_pickle_file_integrity_check",
        )
    ]
    return {
        "defaultHttpsContextPreserved": preserved,
        "moduleLoads": error is None,
        "modelContractPreserved": model is not None
        and all(callable(getattr(model, name, None)) for name in ("initialize", "execute"))
        and model.auto_complete_config("sentinel") == "sentinel",
        "diagnosticsPreserved": all(callable(value) for value in diagnostics)
        and state["integrityChecks"] >= 1,
    }


try:
    operation = request_data["operation"]
    if operation == "lightrag-wildcard-cors-credentials":
        result = observe_lightrag()
    elif operation == "glances-configurable-cors-credentials":
        result = observe_glances()
    elif operation == "sagemaker-triton-tls-verification":
        result = observe_sagemaker()
    else:
        raise ValueError("Unsupported Python confirmatory probe")
    print(json.dumps(result))
except Exception as error:
    print(json.dumps({"error": type(error).__name__, "message": str(error)}))
